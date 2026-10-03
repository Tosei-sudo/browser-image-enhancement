import { pipeline } from "./pipeline.js";
//#region src/presets.ts
/**
* Built-in corrections:
*
* - `auto`: automatic stretch per channel (0.5 % clipped at each end, which
*   also removes color casts) and light sharpening. What {@link autoEnhance} runs.
* - `vivid`: `auto` with more contrast and saturation.
* - `soft`: lifted shadows, calmer highlights, less contrast and a little warmth.
* - `satellite`: a stronger stretch (2 % clipped) for hazy aerial and
*   satellite imagery, with sharpening.
* - `document`: for photographed pages: one stretch for all channels that
*   pushes the paper to white, more contrast and crisp sharpening.
* - `blackAndWhite`: stretch, then monochrome with a little extra contrast.
*
* @example
* ```ts
* const out = await presets.vivid.run(img, { output: 'canvas' });
* editor.render(presets.soft.set('shadows', 0.6)); // a preset as a starting point
* ```
*/
const presets = Object.freeze({
	auto: pipeline().autoStretch().sharpen({ amount: .3 }),
	vivid: pipeline().autoStretch().contrast(.12).saturation(.25).sharpen({ amount: .4 }),
	soft: pipeline().shadows(.4).highlights(-.3).contrast(-.1).temperature(.08),
	satellite: pipeline().autoStretch({
		lowPercent: 2,
		highPercent: 2
	}).sharpen({ amount: .6 }),
	document: pipeline().autoStretch({
		linked: true,
		lowPercent: 1,
		highPercent: 10
	}).contrast(.3).sharpen({
		amount: .8,
		radius: 1.5
	}),
	blackAndWhite: pipeline().autoStretch({ linked: true }).saturation(-1).contrast(.15)
});
/**
* One-call automatic correction: runs {@link presets}.auto (automatic stretch
* and light sharpening) and returns the output `options.output` asks for, as
* {@link Pipeline.run} does.
*
* @example
* ```ts
* const fixed = await autoEnhance(file, { output: 'blob', type: 'image/jpeg', quality: 0.9 });
* ```
*/
function autoEnhance(input, options) {
	return presets.auto.run(input, options);
}
//#endregion
export { autoEnhance, presets };

//# sourceMappingURL=presets.js.map