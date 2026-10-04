/** Vector layers of services: one color per layer, and reading features in the right axis order. */
import type Feature from 'ol/Feature.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle, Fill, Stroke, Style } from 'ol/style.js';
import type { StyleLike } from 'ol/style/Style.js';
import { containsCoordinate, type Extent } from 'ol/extent.js';
import type Projection from 'ol/proj/Projection.js';

/** Points, lines and polygons in one color. */
export function plainStyle(color: string): Style {
  const fill = new Fill({ color: `${color}40` });
  const stroke = new Stroke({ color, width: 2 });
  return new Style({ fill, stroke, image: new Circle({ radius: 5, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 1.5 }) }) });
}

export function vectorLayer(features: Feature[], style: StyleLike): VectorLayer<VectorSource<Feature>> {
  return new VectorLayer({ source: new VectorSource<Feature>({ features }), style });
}

/**
 * Moves features read in `projection` to the map's projection. Servers do not
 * agree on axis order for geographic CRSs: when the first coordinates fall in
 * the layer's longitude / latitude box only with x and y swapped, every
 * coordinate is swapped first.
 */
export function toMap(features: Feature[], projection: Projection, geographicBox: Extent | null, mapProjection: string): void {
  if (geographicBox && projection.getUnits() === 'degrees') {
    const first = features.find((f) => f.getGeometry())?.getGeometry();
    const at = first ? firstCoordinate(first.getExtent()) : null;
    if (at && !containsCoordinate(geographicBox, at) && containsCoordinate(geographicBox, [at[1], at[0]])) {
      for (const f of features) {
        f.getGeometry()?.applyTransform((input, output = input, stride = 2) => {
          for (let i = 0; i < input.length; i += stride) {
            const x = input[i];
            output[i] = input[i + 1];
            output[i + 1] = x;
          }
          return output;
        });
      }
    }
  }
  for (const f of features) f.getGeometry()?.transform(projection, mapProjection);
}

function firstCoordinate(extent: Extent): [number, number] | null {
  return Number.isFinite(extent[0]) ? [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2] : null;
}
