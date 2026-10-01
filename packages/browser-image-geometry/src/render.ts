/** Running a plan on the calling thread. */
import { createImageData, type ImageDataLike } from '@browser-image/workers';
import { renderRows } from './resample.js';
import { shrink, type Plan } from './plan.js';

/** Renders the whole output of `plan` from `image` (the full-size source). */
export function renderPlan(image: ImageDataLike, plan: Plan): ImageData {
  const src = shrink(image, plan.levels);
  const out = new Uint8ClampedArray(plan.width * plan.height * 4);
  renderRows(
    { data: src.data, width: src.width, height: src.height, x0: 0, y0: 0 },
    plan.mapping,
    plan.width,
    0,
    plan.height,
    plan.resample,
    plan.background,
    out,
  );
  return createImageData(out, plan.width, plan.height);
}
