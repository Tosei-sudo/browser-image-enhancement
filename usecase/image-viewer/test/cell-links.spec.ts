import { expect, test } from '@playwright/test';
import { plainGeoTiff } from './fixtures.js';

/*
 * URLs and paths in the attribute table are links: a web page opens in a new
 * tab, a path under a URL mapping opens on the map, and a path under a folder
 * mapping asks for the folder once, then opens a text file in a new tab and
 * an image on the map.
 */

test('URLs and paths in attribute cells open as links', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const settings = {
    pathMappings: [
      { prefix: '\\\\nas\\docs', label: '資料NAS' },
      { prefix: 'Z:/cog', url: 'http://localhost:4175/' },
    ],
  };
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) }));
  await page.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>page</p>' }));
  // The folder picker gives a folder of the origin's private file system, which IndexedDB can keep.
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('docs');
  });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(async (bytes) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('docs', { create: true });
    const files: Array<[string, BlobPart]> = [
      ['Scene.tif', new Uint8Array(bytes)],
      ['note.txt', '現地メモ'],
    ];
    for (const [name, data] of files) {
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(data);
      await writable.close();
    }
    const point = (id: number, link: string) => ({ type: 'Feature', properties: { id, link }, geometry: { type: 'Point', coordinates: [139.7 + id * 0.01, 35.6] } });
    const geojson = {
      type: 'FeatureCollection',
      features: [point(1, 'https://example.com/page'), point(2, 'Z:\\cog\\fixture16.tif'), point(3, '\\\\NAS\\docs\\scene.tif'), point(4, '\\\\nas\\docs\\note.txt'), point(5, 'ただの文字')],
    };
    await window.viewer.project.openFiles([new File([JSON.stringify(geojson)], 'points.geojson')]);
  }, Array.from(plainGeoTiff(300, 200)));

  const table = page.locator('#table');
  const links = table.locator('.cell-link');
  await expect(links).toHaveCount(4);
  await expect(table.locator('td', { hasText: 'ただの文字' }).locator('.cell-link')).toHaveCount(0);
  const web = links.filter({ hasText: 'https://example.com/page' });
  await expect(web).toHaveAttribute('href', 'https://example.com/page');
  await expect(web).toHaveAttribute('target', '_blank');

  // A web page opens in a new tab, without selecting the row.
  const popup = page.waitForEvent('popup');
  await web.click();
  await (await popup).close();
  await expect(table.locator('.table-count')).toContainText('選択 0 件');

  // Right-clicking a link offers to open it in a tab and to copy it.
  await links.filter({ hasText: 'scene.tif' }).click({ button: 'right' });
  const menu = page.locator('.context-menu[aria-label="選択した地物"]:visible');
  await expect(menu).toContainText('リンク先を地図に表示');
  await expect(menu).toContainText('リンク先を新しいタブで開く');
  await expect(menu).toContainText('パスをコピー');
  await page.keyboard.press('Escape');

  // A path under a URL mapping opens on the map as a COG.
  await links.filter({ hasText: 'fixture16.tif' }).click();
  await expect(page.locator('#images .name', { hasText: 'fixture16.tif' })).toHaveCount(1);

  // A path under the NAS asks for its folder once; a text file opens in a new tab.
  await page.locator('#images .name', { hasText: 'points' }).click();
  const textTab = page.waitForEvent('popup');
  await links.filter({ hasText: 'note.txt' }).click();
  const ask = page.locator('dialog.folder-ask');
  await expect(ask).toContainText('「資料NAS」のフォルダ');
  await ask.getByRole('button', { name: 'フォルダを選択…' }).click();
  const tab = await textTab;
  await expect(tab.locator('body')).toContainText('現地メモ');
  await tab.close();

  // With the folder remembered, an image opens on the map, whatever the case of its name.
  await links.filter({ hasText: 'scene.tif' }).click();
  await expect(page.locator('#images .name', { hasText: 'Scene.tif' })).toHaveCount(1);
  await expect(ask).toHaveCount(0);
  expect(errors).toEqual([]);
});
