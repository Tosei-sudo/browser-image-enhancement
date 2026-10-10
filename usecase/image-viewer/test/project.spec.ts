import { expect, test, type Page } from '@playwright/test';

/*
 * Project files (.ivproj): what is open saves as one file and opens again as
 * it was. The pickers are stood in for by ones that return files of the
 * origin's private file system, which gives real handles, as Chrome's do.
 */

const stations = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: '東京駅' }, geometry: { type: 'Point', coordinates: [139.7671, 35.6812] } },
    { type: 'Feature', properties: { name: '新宿駅' }, geometry: { type: 'Point', coordinates: [139.7006, 35.6896] } },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const root = () => navigator.storage.getDirectory();
    const w = window as unknown as Record<string, unknown>;
    // The project picker gives the project, the files picker the GeoJSON.
    w.showOpenFilePicker = async (options?: { id?: string }) => [await (await root()).getFileHandle(options?.id === 'image-viewer-project' ? 'survey.ivproj' : 'stations.geojson')];
    w.showSaveFilePicker = async () => (await root()).getFileHandle('survey.ivproj', { create: true });
  });
});

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function writeOpfs(page: Page, name: string, text: string) {
  await page.evaluate(
    async ([name, text]) => {
      const root = await navigator.storage.getDirectory();
      const writable = await (await root.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    },
    [name, text],
  );
}

const names = (page: Page) => page.evaluate(() => window.viewer.images.layers().map((l) => l.name));

/** The state worth checking of every layer, top first. */
const state = (page: Page) =>
  page.evaluate(() =>
    window.viewer.images.layers().map((l) => ({
      name: l.name,
      visible: l.layer.getVisible(),
      opacity: l.layer.getOpacity(),
      pipeline: l.type === 'image' ? l.source.getPipeline().toJSON().ops : null,
      color: l.type === 'service' ? l.service.style?.get().symbol.fill : null,
    })),
  );

async function openCogAndStations(page: Page) {
  await page.getByRole('button', { name: 'URL を開く（COG・Esri ImageServer）' }).click();
  await page.getByRole('textbox', { name: 'URL を開く（COG・Esri ImageServer）' }).fill(new URL('/fixture.tif', page.url()).href);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  await expect(page.locator('#status')).toContainText('fixture.tif を開きました');
  await page.locator('#open .ol-load-image button').first().click();
  await expect(page.locator('#images .name')).toHaveCount(2);
}

test('a project saves the layers, their styles and corrections and the view, and opens again as it was', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await writeOpfs(page, 'stations.geojson', JSON.stringify(stations));
  await openCogAndStations(page);

  // Change everything a project keeps: order, visibility, opacity, correction, style, base map, view.
  await page.evaluate(() => {
    const { images, map, baseMap } = window.viewer;
    const [stationsLayer, cog] = images.layers();
    if (cog.type !== 'image' || stationsLayer.type !== 'service') throw new Error('unexpected layers');
    const source = cog.source;
    const Pipeline = source.getPipeline().constructor as unknown as { fromJSON(json: object): ReturnType<typeof source.getPipeline> };
    source.setPipeline(Pipeline.fromJSON({ version: 1, ops: [{ op: 'brightness', amount: 0.25 }] }));
    images.setOpacity(cog, 0.4);
    images.setVisible(stationsLayer, false);
    images.move(cog, 1);
    const style = stationsLayer.service.style!;
    style.set({ ...style.get(), mode: 'single', symbol: { ...style.get().symbol, fill: '#ff00aa' } });
    baseMap.set('');
    map.getView().setCenter([15550000, 4255000]);
    map.getView().setResolution(12.5);
  });
  const before = await state(page);
  expect(before.map((l) => l.name)).toEqual([new URL('/fixture.tif', page.url()).href, 'stations']);

  await page.getByRole('button', { name: 'プロジェクト' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('survey.ivproj に保存しました');
  await expect(page).toHaveTitle('survey - 画像ビューア');
  const saved = JSON.parse(
    await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('survey.ivproj')).getFile()).text()),
  );
  expect(saved.format).toBe('browser-image-viewer-project');
  expect(saved.fileSets).toEqual([{ files: [expect.objectContaining({ name: 'stations.geojson' })] }]);
  expect(saved.layers.map((l: { source: { kind: string } }) => l.source.kind)).toEqual(['url', 'files']);

  // A fresh page: the project opens both layers again, the GeoJSON through its kept handle, without asking.
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#images .name')).toHaveCount(0);
  await page.getByRole('button', { name: 'プロジェクト' }).click();
  await page.getByRole('button', { name: '開く…' }).click();
  await expect(page.locator('#status')).toHaveText('プロジェクト「survey」を開きました');
  expect(await state(page)).toEqual(before);
  expect(await page.locator('#images input[type=checkbox]').evaluateAll((boxes) => boxes.map((b) => (b as HTMLInputElement).checked))).toEqual([true, false]);
  const view = await page.evaluate(() => ({ center: window.viewer.map.getView().getCenter(), resolution: window.viewer.map.getView().getResolution(), base: window.viewer.baseMap.get() }));
  expect(view).toEqual({ center: [15550000, 4255000], resolution: 12.5, base: '' });

  // Saved again it goes to the same file, without asking where.
  await page.keyboard.press('Control+s');
  await expect(page.locator('#status')).toHaveText('survey.ivproj に保存しました');
  expect(errors).toEqual([]);
});

test('files a project cannot find are asked for, and can be left out', async ({ page }) => {
  await open(page);
  // The GeoJSON is chosen with the ordinary chooser this time: no handle is kept.
  await page.evaluate(
    ([text]) => {
      const list = new DataTransfer();
      list.items.add(new File([text], 'stations.geojson'));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    },
    [JSON.stringify(stations)],
  );
  await expect(page.locator('#images .name')).toHaveCount(1);
  const text = await page.evaluate(() => JSON.stringify(window.viewer.project.collect().project));
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);

  // Opened by choosing it like any file, the project asks for the GeoJSON.
  const choose = (name: string, body: string) =>
    page.evaluate(
      ([name, body]) => {
        const list = new DataTransfer();
        list.items.add(new File([body], name));
        const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
        input.files = list.files;
        input.dispatchEvent(new Event('change'));
      },
      [name, body],
    );
  await choose('survey.ivproj', text);
  const dialog = page.getByRole('dialog', { name: 'プロジェクトのファイル' });
  await expect(dialog).toContainText('stations.geojson');
  await expect(dialog).toContainText('場所が不明');
  await dialog.getByRole('button', { name: 'これらを省いて開く' }).click();
  await expect(page.locator('#status')).toContainText('開けなかったもの: stations');
  await expect(page.locator('#images .name')).toHaveCount(0);

  // Again, choosing the file in the dialog: the picker finds it by name.
  await writeOpfs(page, 'stations.geojson', JSON.stringify(stations));
  await choose('survey.ivproj', text);
  await dialog.getByRole('button', { name: 'ファイルを選ぶ…' }).click();
  await expect(page.locator('#status')).toHaveText('プロジェクト「survey」を開きました');
  expect(await names(page)).toEqual(['stations']);
});

test('a file that is not a project says so', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const list = new DataTransfer();
    list.items.add(new File(['{"type":"FeatureCollection"}'], 'other.ivproj'));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#status')).toHaveText('other.ivproj を開けませんでした: 画像ビューアのプロジェクトファイルではありません');
});
