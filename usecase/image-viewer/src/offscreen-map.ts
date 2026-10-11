/**
 * A hidden copy of the map showing one layer, for drawing it at another size
 * or scale (the AI tools' analysis) while the map on screen stays as the
 * person left it and keeps working. The copy shares the layer's source (its
 * tiles are not read again) and draws it with the correction it has now.
 */
import OlMap from 'ol/Map.js';
import View from 'ol/View.js';
import type BaseLayer from 'ol/layer/Base.js';
import LayerGroup from 'ol/layer/Group.js';
import ImageLayer from 'ol/layer/Image.js';
import TileLayer from 'ol/layer/Tile.js';
import type Layer from 'ol/layer/Layer.js';
import { GpuCorrectedTileLayer, TileCorrection } from 'browser-image-enhancement/openlayers';
import { pixelRatioOf } from './view-export.js';

export interface OffscreenMap {
  map: OlMap;
  dispose(): void;
}

/** A copy of one of a layer's visible layers, or null when it is of a kind this does not copy. */
function copyOf(layer: Layer): Layer | null {
  const extent = layer.getExtent();
  if (layer instanceof GpuCorrectedTileLayer) {
    const correction = layer.getCorrection();
    // A picture service's correction as it is now (DRA resolved), so the copy neither changes nor follows it.
    const fixed = correction ? new TileCorrection({ pipeline: correction.getEffectivePipeline() }) : undefined;
    return new GpuCorrectedTileLayer({ source: layer.getSource() ?? undefined, correction: fixed, extent });
  }
  if (layer instanceof TileLayer) return new TileLayer({ source: layer.getSource() ?? undefined, extent });
  if (layer instanceof ImageLayer) return new ImageLayer({ source: layer.getSource() ?? undefined, extent });
  return null;
}

/**
 * A hidden map with a copy of `layer` (all its visible layers when it is a
 * group) at `map`'s view, or null when the layer cannot be copied: then it is
 * drawn on the map itself.
 */
export async function offscreenMap(map: OlMap, layer: BaseLayer): Promise<OffscreenMap | null> {
  const view = map.getView();
  const size = map.getSize();
  const leaves = (layer instanceof LayerGroup ? layer.getLayersArray() : [layer as Layer]).filter((l) => l.getVisible());
  const copies = leaves.map(copyOf);
  if (!size || !copies.length || copies.some((c) => !c)) {
    for (const c of copies) c?.dispose();
    return null;
  }
  const target = document.createElement('div');
  target.className = 'offscreen-map';
  target.setAttribute('aria-hidden', 'true');
  target.style.cssText = `position:fixed;left:-${size[0] + 100}px;top:0;width:${size[0]}px;height:${size[1]}px;overflow:hidden;pointer-events:none`;
  document.body.append(target);
  const copy = new OlMap({
    target,
    layers: copies as Layer[],
    controls: [],
    interactions: [],
    pixelRatio: pixelRatioOf(map),
    view: new View({
      projection: view.getProjection(),
      center: view.getCenter(),
      resolution: view.getResolution(),
      rotation: view.getRotation(),
      // Drawn up to 16 times finer than shown: no zoom limit of its own.
      maxZoom: 64,
      constrainResolution: false,
      multiWorld: true,
    }),
  });
  // The map sizes itself to its element once it notices it (before the next frame); drawing sets other sizes after that.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  copy.setSize(size);
  return {
    map: copy,
    dispose() {
      copy.setTarget(undefined);
      for (const c of copies) c!.dispose();
      copy.dispose();
      target.remove();
    },
  };
}
