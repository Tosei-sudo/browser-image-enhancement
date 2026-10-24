import { expect, test, type Page } from '@playwright/test';
import { plainGeoTiff } from './fixtures.js';

/*
 * The status line at the bottom right: many files dropped together are one
 * line saying how far they have got, then what was opened, with what could
 * not be opened and what needs a look counted, listed under 詳細.
 */

async function drop(page: Page, files: Array<{ name: string; bytes: Uint8Array }>) {
  await page.evaluate(
    (files) => {
      const data = new DataTransfer();
      for (const f of files) data.items.add(new File([Uint8Array.from(atob(f.bytes), (c) => c.charCodeAt(0))], f.name, { type: 'image/tiff' }));
      window.viewer.map.getViewport().dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    },
    files.map((f) => ({ name: f.name, bytes: Buffer.from(f.bytes).toString('base64') })),
  );
}

test('many files dropped together are summed up in one line, with the problems under 詳細', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  // Every text the line shows, as it changes.
  await page.evaluate(() => {
    const text = document.querySelector('#status .status-text')!;
    const seen: string[] = ((window as unknown as { seen: string[] }).seen = []);
    new MutationObserver(() => seen.push(text.textContent ?? '')).observe(text, { childList: true, characterData: true, subtree: true });
  });
  const files = [];
  for (let i = 0; i < 12; i++) {
    // Every fourth without a projection, one not a TIFF at all.
    const bytes = i === 5 ? new Uint8Array([1, 2, 3, 4]) : plainGeoTiff(300, 200, { geo: i % 4 === 0 ? 'none' : 'utm' });
    files.push({ name: `scene_${String(i).padStart(2, '0')}.tif`, bytes });
  }
  await drop(page, files);
  const status = page.locator('#status');
  await expect(status).toContainText('11 件のレイヤーをグループ「scene」にまとめて表示（開けなかったもの 1 件・確認 3 件）', { timeout: 30_000 });
  // No file's own message was shown on the way: only the count.
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
  expect(seen.filter((t) => /scene_\d+\.tif/.test(t))).toEqual([]);
  expect(seen.some((t) => /^12 件を読み込み中 \d+\/12/.test(t))).toBe(true);

  // 詳細 lists them, the one not opened first.
  const more = status.getByRole('button', { name: '詳細（4）' });
  await more.click();
  const items = status.locator('.status-details li');
  await expect(items).toHaveCount(4);
  await expect(items.first()).toContainText('scene_05.tif の読み込みに失敗');
  await expect(items.nth(1)).toContainText('scene_00.tif を表示（投影の情報なし');
  await page.screenshot({ path: test.info().outputPath('status-details.png') });
  await page.keyboard.press('Escape');
  await expect(status.locator('.status-details')).toBeHidden();

  // A file opened on its own afterwards is said as before.
  await drop(page, [{ name: 'other.tif', bytes: plainGeoTiff(300, 200) }]);
  await expect(status).toHaveText('other.tif を表示');
  await expect(more).toBeHidden();
});
