/**
 * The legend of the images shown in color classes (see the coloring
 * dialog): a small box at the bottom right of the map with a row per class,
 * its color and name, for each such image that is shown. It folds to its
 * title, and follows the layers as they are colored, shown or hidden.
 */
import type OlMap from 'ol/Map.js';
import type { ImageList } from './images.js';
import { classLabel, cssColor } from './colorize-dialog.js';

export class ClassLegend {
  readonly element: HTMLDetailsElement;
  private key_ = '';

  constructor(
    private readonly map: OlMap,
    private readonly images: ImageList,
  ) {
    this.element = document.createElement('details');
    this.element.className = 'map-class-legend';
    this.element.open = true;
    this.element.hidden = true;
    map.getViewport().append(this.element);
    map.on('rendercomplete', () => this.update());
  }

  /** Draws the legend again when the classed images shown or their classes changed. */
  update(): void {
    const shown = this.images.list().flatMap((image) => {
      const classes = image.layer.getVisible() ? image.layer.getColorScale()?.classes : null;
      return classes?.classes.length ? [{ name: image.name, classes }] : [];
    });
    const key = JSON.stringify(shown);
    if (key === this.key_) return;
    this.key_ = key;
    this.element.hidden = shown.length === 0;
    const summary = document.createElement('summary');
    summary.textContent = '凡例';
    const parts = shown.map(({ name, classes }) => {
      const part = document.createElement('section');
      const title = document.createElement('h3');
      title.textContent = name;
      const list = document.createElement('ul');
      const order = classes.classes.map((c, i) => [c.value, i] as const).sort((a, b) => a[0] - b[0]);
      list.append(
        ...order.map(([, i]) => {
          const row = document.createElement('li');
          const swatch = document.createElement('span');
          swatch.className = 'class-swatch';
          swatch.style.background = cssColor(classes.classes[i].color);
          row.append(swatch, classLabel(classes, i));
          return row;
        }),
      );
      part.append(title, list);
      return part;
    });
    this.element.replaceChildren(summary, ...parts);
  }
}
