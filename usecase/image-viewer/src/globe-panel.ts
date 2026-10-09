/**
 * The 「3D」 button: opens the 3D view (globe.ts) over the map, loading
 * CesiumJS the first time, and its section of the side panel. The 2D tools
 * that work on the 2D view (measuring, points, swipe, histogram, saving the
 * view) wait while it is open.
 */
import type OlMap from 'ol/Map.js';
import type { Globe, GlobeContext } from './globe.js';

export interface GlobeToggleOptions {
  button: HTMLButtonElement;
  /** The side panel section the 3D settings go in (hidden in 2D). */
  section: HTMLElement;
  panel: HTMLElement;
  /** Called as the 3D view opens and closes. */
  onToggle: (open: boolean) => void;
  context: GlobeContext;
}

export class GlobeToggle {
  private globe_: Globe | null = null;
  private loading_: Promise<Globe> | null = null;

  constructor(
    private readonly map: OlMap,
    private readonly options: GlobeToggleOptions,
  ) {
    options.button.addEventListener('click', () => void this.toggle());
  }

  /** The 3D view, once loaded. */
  globe(): Globe | null {
    return this.globe_;
  }

  isOpen(): boolean {
    return this.globe_?.isOpen() ?? false;
  }

  async toggle(open = !this.isOpen()): Promise<void> {
    const { button, section, onToggle, context } = this.options;
    if (!open) {
      if (!this.globe_?.isOpen()) return;
      await this.globe_.close();
      this.show_(false);
      onToggle(false);
      return;
    }
    if (this.isOpen()) return;
    button.disabled = true;
    if (!this.globe_) context.say('3D 表示を読み込んでいます…');
    try {
      const globe = await this.load_();
      this.show_(true);
      globe.open();
      onToggle(true);
      context.say('3D 表示にしました（2D の全レイヤーを地表に重ねています）');
    } catch (error) {
      context.say(`3D 表示を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
      this.show_(false);
    } finally {
      button.disabled = false;
    }
    section.hidden = !this.isOpen();
  }

  private show_(open: boolean): void {
    const { button, section } = this.options;
    button.setAttribute('aria-pressed', String(open));
    section.hidden = !open;
    this.map.getTargetElement()?.classList.toggle('globe-open', open);
  }

  private load_(): Promise<Globe> {
    this.loading_ ??= (async () => {
      // CesiumJS loads its workers and assets from here (put there by vite.config.ts).
      (window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = new URL('./cesium/', document.baseURI).href;
      const { Globe } = await import('./globe.js');
      const container = document.createElement('div');
      container.className = 'globe';
      container.hidden = true;
      // Over the layers but under the map's controls (the correction panel stays usable).
      const viewport = this.map.getViewport();
      viewport.insertBefore(container, viewport.querySelector('.ol-overlaycontainer'));
      this.globe_ = new Globe(container, this.options.panel, this.options.context);
      return this.globe_;
    })();
    this.loading_.catch(() => (this.loading_ = null));
    return this.loading_;
  }
}
