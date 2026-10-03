import { LUMA_B, LUMA_G, LUMA_R, srgbToLinear } from "../color/srgb.js";
import { curveFunction } from "../ops/curve.js";
import { CONTRAST_PIVOT, TONE_STRENGTH, temperatureGains, tintGains, whiteBalanceGains } from "../ops/index.js";
//#region src/gpu/shaders.ts
/**
* GLSL for the WebGL2 path. The same math as ops/index.ts and core/filter.ts,
* in float32 on the GPU instead of float64, so results can differ from the JS
* engine by one 8-bit level where a value lands next to a rounding boundary.
*
* Shaders depend only on the kinds of the steps (and the color mode); their
* parameters are uniforms, so moving a slider reuses the compiled program.
*/
/** Fullscreen triangle; fragment shaders address pixels by `gl_FragCoord`. */
const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;
/** Samples per curve in the curve texture (linearly interpolated between them). */
const CURVE_SAMPLES = 1024;
const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
const vec3 LUMA = vec3(${LUMA_R}, ${LUMA_G}, ${LUMA_B});
float enc(float v) { return v > 0.0 ? (v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055) : 0.0; }
vec3 enc3(vec3 v) { return vec3(enc(v.r), enc(v.g), enc(v.b)); }
float dec(float e) { return e <= 0.04045 ? e / 12.92 : pow((e + 0.055) / 1.055, 2.4); }
vec3 dec3(vec3 e) { return vec3(dec(e.r), dec(e.g), dec(e.b)); }
float powPos(float v, float e) { return v > 0.0 ? pow(v, e) : 0.0; }
float contrast(float v, float p, float k) { return v > 0.0 ? p * pow(v / p, k) : 0.0; }
float levels(float v, vec4 a, float outRange) {
  float x = (enc(v) - a.x) / a.y;
  x = x <= 0.0 ? 0.0 : x >= 1.0 ? 1.0 : pow(x, a.z);
  return dec(a.w + x * outRange);
}
float stretch(float v, float black, float scale) {
  float x = (enc(v) - black) * scale;
  return x <= 0.0 ? 0.0 : x >= 1.0 ? 1.0 : dec(x);
}
float tone(float v, float k, float high) {
  if (!(v > 0.0) || v >= 1.0) return v;
  float x = enc(v);
  return dec(x + k * x * (1.0 - x) * mix(1.0 - x, x, high));
}
uniform sampler2D u_curves;
/** The curves of row \`row\` of u_curves (R, G, B: already composed with the curve for all channels), on sRGB-encoded values. */
vec3 curve(vec3 v, float row) {
  vec3 x = clamp(enc3(v), 0.0, 1.0) * 1023.0;
  vec3 i = min(floor(x), vec3(1022.0));
  vec3 f = x - i;
  int y = int(row);
  vec3 lo = vec3(texelFetch(u_curves, ivec2(int(i.r), y), 0).r, texelFetch(u_curves, ivec2(int(i.g), y), 0).g, texelFetch(u_curves, ivec2(int(i.b), y), 0).b);
  vec3 hi = vec3(texelFetch(u_curves, ivec2(int(i.r) + 1, y), 0).r, texelFetch(u_curves, ivec2(int(i.g) + 1, y), 0).g, texelFetch(u_curves, ivec2(int(i.b) + 1, y), 0).b);
  return dec3(mix(lo, hi, f));
}
/** 8-bit code of a linear value, rounded half up, as a unorm value. */
float quant(float v) { return floor(clamp(enc(v), 0.0, 1.0) * 255.0 + 0.5) / 255.0; }
out vec4 o;
`;
/** GLSL applying `op` to the linear \`vec3 v\`, with its parameters in \`u_op[2 * i]\` and \`u_op[2 * i + 1]\`. */
function opCode(op, i) {
	const a = `u_op[${2 * i}]`;
	const b = `u_op[${2 * i + 1}]`;
	switch (op.op) {
		case "brightness": return `v = v * ${a}.x + ${a}.y;`;
		case "contrast": return `v = vec3(contrast(v.r, ${a}.x, ${a}.y), contrast(v.g, ${a}.x, ${a}.y), contrast(v.b, ${a}.x, ${a}.y));`;
		case "exposure": return `v *= ${a}.x;`;
		case "gamma": return `v = vec3(powPos(v.r, ${a}.x), powPos(v.g, ${a}.x), powPos(v.b, ${a}.x));`;
		case "saturation": return `{ float y = dot(LUMA, v); v = y + (v - y) * ${a}.x; }`;
		case "temperature":
		case "tint":
		case "whiteBalance": return `v *= ${a}.xyz;`;
		case "shadows":
		case "highlights": return `v = vec3(tone(v.r, ${a}.x, ${a}.y), tone(v.g, ${a}.x, ${a}.y), tone(v.b, ${a}.x, ${a}.y));`;
		case "curve": return `v = curve(v, ${a}.x);`;
		case "levels": return `v = vec3(levels(v.r, ${a}, ${b}.x), levels(v.g, ${a}, ${b}.x), levels(v.b, ${a}, ${b}.x));`;
		case "stretch": return `v = vec3(stretch(v.r, ${a}.x, ${b}.x), stretch(v.g, ${a}.y, ${b}.y), stretch(v.b, ${a}.z, ${b}.z));`;
	}
}
/**
* The two vec4 uniforms of `op`, matching {@link opCode} and the math in
* ops/index.ts. `curveRow` is the row of the curve texture holding a `curve` op.
*/
function opParams(op, out, i, curveRow = 0) {
	const a = 8 * i;
	out.fill(0, a, a + 8);
	switch (op.op) {
		case "brightness": {
			const b = op.amount;
			out[a] = 1 - Math.abs(b);
			out[a + 1] = b > 0 ? b : 0;
			return;
		}
		case "contrast": {
			const c = op.amount;
			out[a] = CONTRAST_PIVOT;
			out[a + 1] = c >= 0 ? 1 / Math.max(1 - c, 1 / 1024) : 1 + c;
			return;
		}
		case "exposure":
			out[a] = Math.pow(2, op.ev);
			return;
		case "gamma":
			out[a] = 1 / op.gamma;
			return;
		case "saturation":
			out[a] = 1 + op.amount;
			return;
		case "temperature":
			out.set(temperatureGains(op.amount), a);
			return;
		case "tint":
			out.set(tintGains(op.amount), a);
			return;
		case "whiteBalance":
			out.set(whiteBalanceGains(op), a);
			return;
		case "shadows":
		case "highlights":
			out[a] = TONE_STRENGTH * op.amount;
			out[a + 1] = op.op === "highlights" ? 1 : 0;
			return;
		case "curve":
			out[a] = curveRow;
			return;
		case "levels":
			out.set([
				op.inBlack,
				op.inWhite - op.inBlack,
				1 / op.gamma,
				op.outBlack,
				op.outWhite - op.outBlack
			], a);
			return;
		case "stretch":
			out.set(op.black, a);
			out.set(op.black.map((b, c) => 1 / (op.white[c] - b)), a + 4);
			return;
	}
}
function uniforms(ops) {
	return `uniform vec4 u_op[${Math.max(2, 2 * ops.length)}];\n`;
}
/**
* Output of a pass: the final 8-bit result (alpha copied), or sRGB-encoded
* values for a following sharpen (float, not clamped). Gray mode keeps the
* value in all three channels and outputs the first.
*/
function output(final, gray) {
	const v = gray ? "vec3(v.r)" : "v";
	return final ? `o = vec4(quant(${v}.r), quant(${v}.g), quant(${v}.b), a);` : `o = vec4(enc3(${v}), a);`;
}
/**
* First pass: 8-bit input (an RGBA8UI texture) -> linear via the decoding
* table -> `ops` -> output. In gray mode a colored pixel is computed on its
* luminance, as in the JS engine.
*/
function pixelShader(ops, gray, final) {
	return `${HEADER}uniform usampler2D u_src;
uniform sampler2D u_lut;
${uniforms(ops)}
float lin(uint c) { return texelFetch(u_lut, ivec2(int(c), 0), 0).r; }
void main() {
  uvec4 s = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0);
  vec3 v = vec3(lin(s.r), lin(s.g), lin(s.b));
  ${gray ? "if (s.r != s.g || s.g != s.b) v = vec3(dot(LUMA, v)); else v = vec3(v.r);" : ""}
  float a = float(s.a) / 255.0;
  ${ops.map(opCode).join("\n  ")}
  ${output(final, gray)}
}`;
}
/**
* Horizontal half of the blur: alpha-weighted luminance and the weight, summed
* over the taps inside the row (pixels outside count as transparent).
*/
function horizontalShader(gray) {
	return `${HEADER}uniform sampler2D u_src;
uniform sampler2D u_kernel;
uniform int u_r;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int w = textureSize(u_src, 0).x;
  int lo = max(-u_r, -p.x);
  int hi = min(u_r, w - 1 - p.x);
  float sn = 0.0;
  float sd = 0.0;
  for (int i = lo; i <= hi; i++) {
    vec4 e = texelFetch(u_src, ivec2(p.x + i, p.y), 0);
    float k = texelFetch(u_kernel, ivec2(i + u_r, 0), 0).r;
    float l = ${gray ? "e.r" : "dot(LUMA, e.rgb)"};
    sn += k * (e.a > 0.0 ? e.a * l : 0.0);
    sd += k * e.a;
  }
  o = vec4(sn, sd, 0.0, 0.0);
}`;
}
/**
* Vertical half of the blur, the mask itself, then `ops` (the per-pixel
* steps up to the next sharpen) and the output.
*/
function verticalShader(ops, gray, final) {
	const tail = ops.length > 0 ? `vec3 v = dec3(e);\n  ${ops.map(opCode).join("\n  ")}\n  ${output(final, gray)}` : final ? "o = vec4(floor(clamp(e, 0.0, 1.0) * 255.0 + 0.5) / 255.0, a);" : "o = vec4(e, a);";
	return `${HEADER}uniform sampler2D u_src;
uniform sampler2D u_blur;
uniform sampler2D u_kernel;
uniform int u_r;
uniform float u_amount;
uniform float u_threshold;
${uniforms(ops)}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int h = textureSize(u_src, 0).y;
  int lo = max(-u_r, -p.y);
  int hi = min(u_r, h - 1 - p.y);
  vec2 s = vec2(0.0);
  for (int j = lo; j <= hi; j++) {
    s += texelFetch(u_kernel, ivec2(j + u_r, 0), 0).r * texelFetch(u_blur, ivec2(p.x, p.y + j), 0).rg;
  }
  vec4 src = texelFetch(u_src, p, 0);
  vec3 e = ${gray ? "vec3(src.r)" : "src.rgb"};
  float a = src.a;
  if (a > 0.0 && s.y > 0.0) {
    float diff = ${gray ? "e.r" : "dot(LUMA, e)"} - s.x / s.y;
    if (abs(diff) >= u_threshold) e += u_amount * diff;
  }
  ${tail}
}`;
}
/** Copies the 8-bit result to the canvas, flipping rows (GL's origin is the bottom left). */
const PRESENT = `${HEADER}uniform sampler2D u_src;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = texelFetch(u_src, ivec2(p.x, textureSize(u_src, 0).y - 1 - p.y), 0);
}`;
/** One row of the curve texture: RGBA samples of the composed curves (the curve for all channels, then each channel's own). */
function curveRow(op, out, row) {
	const all = curveFunction(op.points);
	const own = [
		op.red,
		op.green,
		op.blue
	].map(curveFunction);
	const o = row * CURVE_SAMPLES * 4;
	for (let k = 0; k < CURVE_SAMPLES; k++) {
		const y = all(k / 1023);
		for (let c = 0; c < 3; c++) out[o + 4 * k + c] = own[c](y);
		out[o + 4 * k + 3] = 1;
	}
}
/** Decoding table: linear value of each 8-bit sRGB code. */
const DECODE = /* @__PURE__ */ (() => {
	const t = /* @__PURE__ */ new Float32Array(256);
	for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
	return t;
})();
//#endregion
export { CURVE_SAMPLES, DECODE, PRESENT, VERTEX, curveRow, horizontalShader, opParams, pixelShader, verticalShader };

//# sourceMappingURL=shaders.js.map