import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { toBase64 } from './fixtures.js';

/*
 * NITF and SICD files open like GeoTIFFs: read in place, placed by their
 * corners or RPC, a SICD shown as amplitude. The files are test/data/nitf
 * (see nitf.test.ts).
 */

async function choose(page: Page, names: string[]) {
  const files = names.map((name) => ({ name, base64: toBase64(readFileSync(new URL(`./data/nitf/${name}`, import.meta.url))) }));
  await page.evaluate((files) => {
    const list = new DataTransfer();
    for (const f of files) list.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, files);
}

/** The mean of the map canvas's pixels' red, green and blue, as drawn. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const canvas = [...document.querySelectorAll<HTMLCanvasElement>('#map canvas')].find((c) => c.width > 0)!;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const d = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      sum += d[i] + d[i + 1] + d[i + 2];
      n++;
    }
    return n ? sum / n / 3 : 0;
  });

test('a NITF and a SICD open, are placed where they belong and are drawn', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);

  await choose(page, ['rgb-blocks.ntf']);
  await expect(page.locator('#status')).toContainText('rgb-blocks.ntf を開きました');
  await expect(page.locator('#info')).toContainText('NITF02.10');
  await expect(page.locator('#info')).toContainText('EPSG:4326');
  await expect.poll(() => drawn(page)).toBeGreaterThan(5);

  await choose(page, ['re32f.sicd']);
  await expect(page.locator('#status')).toContainText('re32f.sicd を開きました');
  await expect(page.locator('#info')).toContainText('SICD');
  await expect(page.locator('#info')).toContainText('複素数から求めた振幅');
  await expect(page.locator('#info')).toContainText('GCP 25 点');
  // Fitted to the view: its middle is between the corners in the XML.
  const center = await page.evaluate(() => window.viewer.map.getView().getCenter()!);
  const lon = (center[0] / 6378137) * (180 / Math.PI);
  expect(lon).toBeGreaterThan(139.7);
  expect(lon).toBeLessThan(139.81);
  await expect.poll(() => drawn(page)).toBeGreaterThan(5);

  await page.locator('#metadata-open').click();
  await expect(page.locator('.metadata-dialog')).toContainText('NITF_IREP');
  await expect(page.locator('.metadata-dialog')).toContainText('SICD_CollectorName');
  expect(errors).toEqual([]);
});

test('a JPEG 2000 NITF is refused with the reason', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await choose(page, ['jpeg2000.ntf']);
  await expect(page.locator('#status')).toContainText('JPEG 2000 で圧縮された NITF には対応していません');
});
