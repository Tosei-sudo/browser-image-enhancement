import { expect, test, type Page } from '@playwright/test';

/*
 * Side by side comparison: /fixture.tif and /fixture16.tif side by side, the
 * second pane showing the layer under the top one; the panes share the view,
 * a cross follows the cursor, four panes, and the split is kept in projects.
 */

/** Waits for a map to finish drawing. */
const rendered = (page: Page, pane = -1) =>
  page.evaluate(
    (pane) =>
      new Promise<void>((resolve) => {
        const map = pane < 0 ? window.viewer.map : window.viewer.split.paneMaps()[pane];
        map.once('rendercomplete', () => resolve());
        map.render();
      }),
    pane,
  );

test('two panes share the view, each showing its own layer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html?url=/fixture.tif&url=/fixture16.tif');
  await expect(page.locator('#status')).toContainText('fixture16.tif を表示');
  await expect.poll(() => page.evaluate(() => window.viewer.images.list().length)).toBe(2);
  const mapBox = (await page.locator('#map').boundingBox())!;

  await page.locator('#split').click();
  await expect(page.locator('#split')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#split-counts')).toBeVisible();
  await expect(page.locator('.split-pane')).toHaveCount(1);
  // The map is the left half; the pane the right one, showing the layer under the top one.
  await expect.poll(async () => Math.round((await page.locator('#map').boundingBox())!.width)).toBe(Math.round(mapBox.width / 2));
  await expect(page.locator('.split-pane select')).toHaveValue('1');
  await expect(page.locator('.split-pane select option:checked')).toHaveText('/fixture.tif');
  await rendered(page, 0);

  // One view: zooming the map moves the pane.
  const [same, layers] = await page.evaluate(() => {
    const pane = window.viewer.split.paneMaps()[0];
    window.viewer.map.getView().setZoom(window.viewer.map.getView().getZoom()! + 1);
    return [pane.getView() === window.viewer.map.getView(), pane.getLayers().getLength()];
  });
  expect(same).toBe(true);
  expect(layers).toBe(1);

  // The cursor over the map shows as a cross in the pane.
  await page.mouse.move(mapBox.x + mapBox.width / 4, mapBox.y + mapBox.height / 2);
  await expect(page.locator('.split-pane .split-cross')).toBeVisible();

  // Another layer in the pane; four panes; the choices follow.
  await page.locator('.split-pane select').selectOption({ label: '/fixture16.tif' });
  expect(await page.evaluate(() => window.viewer.split.paneLayers().map((l) => l?.name))).toEqual(['/fixture16.tif']);
  await page.locator('#split-counts button[data-count="4"]').click();
  await expect(page.locator('.split-pane')).toHaveCount(3);
  expect(await page.evaluate(() => window.viewer.split.paneLayers().map((l) => l?.name ?? null))).toEqual(['/fixture16.tif', null, null]);
  await expect(page.locator('.split-pane.empty')).toHaveCount(2);

  // Kept in a project (by the layers' indexes there; here, the list's), and put back.
  const state = await page.evaluate(() => {
    const { split, images } = window.viewer;
    return split.getState((l) => images.layers().indexOf(l));
  });
  expect(state).toEqual({ count: 4, layers: [0, null, null] });
  const restored = await page.evaluate(() => {
    const { split, images } = window.viewer;
    split.setState({ count: 2, layers: [1] }, (i) => images.layers()[i] ?? null);
    return split.paneLayers().map((l) => l?.name);
  });
  expect(restored).toEqual(['/fixture.tif']);
  await expect(page.locator('.split-pane')).toHaveCount(1);

  // Off: the map has the whole area again.
  await page.keyboard.press('Escape');
  await page.locator('#split').click();
  await expect(page.locator('.split-pane')).toHaveCount(0);
  await expect(page.locator('#split-counts')).toBeHidden();
  await expect.poll(async () => Math.round((await page.locator('#map').boundingBox())!.width)).toBe(Math.round(mapBox.width));
  expect(errors).toEqual([]);
});
