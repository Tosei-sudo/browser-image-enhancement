/**
 * Whether OpenLayers' WebGL layers can draw float tiles smoothly: WebGL 1
 * (what OpenLayers uses) with float textures (`OES_texture_float`) that can
 * be filtered (`OES_texture_float_linear`). Without filtering, a float tile
 * would be drawn with nearest-neighbour sampling, blocky once zoomed in.
 */
let filterable: boolean | null = null;

/** True when float tiles can be drawn with bilinear filtering; probed once with a throwaway WebGL context. */
export function floatTexturesFilterable(): boolean {
  if (filterable !== null) return filterable;
  filterable = false;
  if (typeof document === 'undefined') return filterable;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      filterable = gl.getExtension('OES_texture_float') !== null && gl.getExtension('OES_texture_float_linear') !== null;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // No WebGL: tiles are stretched on the CPU.
  }
  return filterable;
}
