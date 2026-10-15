import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/*
 * Notes drawn on the map (arrows, lines, boxes, text), kept in the browser,
 * and the print layout: the view on an A4 or A3 sheet with a title, scale
 * bar, north arrow and legend, as a PDF or PNG. /fixture.tif is 512 × 256
 * RGB over 139.6–139.9 E, 35.6–35.75 N.
 */

async function open(page: Page) {
  await page.goto('/index.html?url=/fixture.tif');
  await expect(page.locator('#status')).toContainText('fixture.tif を開きました');
  await page.waitForFunction(() => window.viewer.map.getView().getResolution() !== undefined);
}

const notes = (page: Page) => page.evaluate(() => (window.viewer.annotations.get()?.features ?? []).map((f) => (f as { properties: Record<string, unknown> }).properties));

test('notes are drawn with the toolbar, typed in place, deleted, and kept after a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const map = page.locator('#map');
  const box = (await map.boundingBox())!;

  // N shows the toolbar; an arrow is two clicks and a double click.
  await map.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('n');
  const bar = page.getByRole('toolbar', { name: '注記' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: '矢印' }).click();
  await map.click({ position: { x: box.width / 2 - 100, y: box.height / 2 } });
  await map.dblclick({ position: { x: box.width / 2, y: box.height / 2 - 60 } });
  await expect.poll(() => notes(page)).toEqual([expect.objectContaining({ kind: 'arrow', size: 'medium' })]);

  // Text: a click, then typed where it goes.
  await bar.getByRole('button', { name: '文字' }).click();
  await map.click({ position: { x: box.width / 2 + 80, y: box.height / 2 + 40 } });
  const input = page.getByRole('textbox', { name: '注記の文字' });
  await expect(input).toBeFocused();
  await input.fill('調査地点');
  await input.press('Enter');
  await expect.poll(async () => (await notes(page)).map((n) => n.kind)).toEqual(['arrow', 'text']);
  // Clicks while drawing don't open feature popups or add points.
  expect(await page.evaluate(() => window.viewer.annotations.isActive())).toBe(true);

  // Kept in the browser.
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect.poll(async () => (await notes(page)).map((n) => n.text ?? n.kind)).toEqual(['arrow', '調査地点']);
  // Off by default after a reload; すべて消去 clears them.
  await expect(page.getByRole('toolbar', { name: '注記' })).toBeHidden();
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#annotate').click();
  await page.getByRole('toolbar', { name: '注記' }).getByRole('button', { name: 'すべて消去' }).click();
  expect(await notes(page)).toEqual([]);
  await page.getByRole('toolbar', { name: '注記' }).getByRole('button', { name: '終了' }).click();
  await expect(page.getByRole('toolbar', { name: '注記' })).toBeHidden();
  expect(errors).toEqual([]);
});

test('the print layout saves a PDF and a PNG of the sheet with the map and its parts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.evaluate(() => {
    const center = window.viewer.map.getView().getCenter()!;
    window.viewer.annotations.set({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: center }, properties: { kind: 'text', text: 'ここ', color: '#e11d48', size: 'large' } }],
    });
  });
  const view = await page.evaluate(() => [window.viewer.map.getSize(), window.viewer.map.getView().getCenter(), window.viewer.map.getView().getResolution()]);

  const print = async (choices: { title?: string; format?: string; paper?: string }) => {
    await page.getByRole('button', { name: 'ツール' }).click();
    await page.locator('#print').click();
    const dialog = page.locator('.print-dialog');
    await expect(dialog).toBeVisible();
    if (choices.title !== undefined) await dialog.getByRole('textbox', { name: 'タイトル' }).fill(choices.title);
    if (choices.format) await dialog.locator('select[name=format]').selectOption(choices.format);
    if (choices.paper) await dialog.locator('select[name=paper]').selectOption(choices.paper);
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '保存' }).click();
    return download;
  };

  const pdf = await print({ title: 'survey' });
  expect(pdf.suggestedFilename()).toBe('survey.pdf');
  const pdfText = (await readFile((await pdf.path())!)).toString('latin1');
  expect(pdfText.startsWith('%PDF-')).toBe(true);
  // A4 landscape in points.
  expect(pdfText).toContain('/MediaBox [0 0 841.89 595.28]');
  await expect(page.locator('#status')).toContainText('survey.pdf を保存しました（A4 横、150 dpi）');

  const png = await print({ format: 'png', paper: 'A3' });
  const base64 = (await readFile((await png.path())!)).toString('base64');
  const sheet = await page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return { size: [bitmap.width, bitmap.height], corner: px(5, 5), middle: px(bitmap.width >> 1, bitmap.height >> 1) };
  }, base64);
  // A3 landscape at 150 dpi; white paper at the margin, the image in the middle.
  expect(sheet.size).toEqual([2480, 1754]);
  expect(sheet.corner).toEqual([255, 255, 255, 255]);
  expect(sheet.middle).not.toEqual([255, 255, 255, 255]);
  // The map is back as it was.
  expect(await page.evaluate(() => [window.viewer.map.getSize(), window.viewer.map.getView().getCenter(), window.viewer.map.getView().getResolution()])).toEqual(view);
  expect(errors).toEqual([]);
});
