//#region src/ops/info.ts
const CURVE = {
	type: "curve",
	default: [[0, 0], [1, 1]]
};
const amount = (step = .01) => ({
	type: "number",
	min: -1,
	max: 1,
	default: 0,
	step
});
/**
* Parameter ranges, defaults and suggested slider steps of every correction
* step, plus what kind of step it is.
*
* @example
* ```ts
* const { min, max, step, default: value } = opInfo.contrast.params.amount as NumberParamInfo;
* slider.min = String(min); slider.max = String(max); slider.step = String(step); slider.value = String(value);
* slider.oninput = () => (p = p.set('contrast', Number(slider.value)));
* ```
*/
const opInfo = {
	brightness: {
		params: { amount: amount() },
		value: "amount",
		colorOnly: false,
		spatial: false,
		auto: false
	},
	contrast: {
		params: { amount: amount() },
		value: "amount",
		colorOnly: false,
		spatial: false,
		auto: false
	},
	exposure: {
		params: { ev: {
			type: "number",
			min: -10,
			max: 10,
			default: 0,
			step: .05
		} },
		value: "ev",
		colorOnly: false,
		spatial: false,
		auto: false
	},
	gamma: {
		params: { gamma: {
			type: "number",
			min: .1,
			max: 10,
			default: 1,
			step: .01
		} },
		value: "gamma",
		colorOnly: false,
		spatial: false,
		auto: false
	},
	saturation: {
		params: { amount: amount() },
		value: "amount",
		colorOnly: true,
		spatial: false,
		auto: false
	},
	temperature: {
		params: { amount: amount() },
		value: "amount",
		colorOnly: true,
		spatial: false,
		auto: false
	},
	tint: {
		params: { amount: amount() },
		value: "amount",
		colorOnly: true,
		spatial: false,
		auto: false
	},
	whiteBalance: {
		params: {
			r: {
				type: "number",
				min: 1 / 255,
				max: 1,
				default: .5,
				step: 1 / 255
			},
			g: {
				type: "number",
				min: 1 / 255,
				max: 1,
				default: .5,
				step: 1 / 255
			},
			b: {
				type: "number",
				min: 1 / 255,
				max: 1,
				default: .5,
				step: 1 / 255
			}
		},
		value: null,
		colorOnly: true,
		spatial: false,
		auto: false
	},
	shadows: {
		params: { amount: amount() },
		value: "amount",
		colorOnly: false,
		spatial: false,
		auto: false
	},
	highlights: {
		params: { amount: amount() },
		value: "amount",
		colorOnly: false,
		spatial: false,
		auto: false
	},
	curve: {
		params: {
			points: CURVE,
			red: CURVE,
			green: CURVE,
			blue: CURVE
		},
		value: null,
		colorOnly: false,
		spatial: false,
		auto: false
	},
	levels: {
		params: {
			inBlack: {
				type: "number",
				min: 0,
				max: 1,
				default: 0,
				step: 1 / 255
			},
			inWhite: {
				type: "number",
				min: 0,
				max: 1,
				default: 1,
				step: 1 / 255
			},
			gamma: {
				type: "number",
				min: .1,
				max: 10,
				default: 1,
				step: .01
			},
			outBlack: {
				type: "number",
				min: 0,
				max: 1,
				default: 0,
				step: 1 / 255
			},
			outWhite: {
				type: "number",
				min: 0,
				max: 1,
				default: 1,
				step: 1 / 255
			}
		},
		value: null,
		colorOnly: false,
		spatial: false,
		auto: false
	},
	stretch: {
		params: {
			black: {
				type: "rgb",
				min: 0,
				max: 1,
				default: 0,
				step: 1 / 255
			},
			white: {
				type: "rgb",
				min: 0,
				max: 1,
				default: 1,
				step: 1 / 255
			}
		},
		value: null,
		colorOnly: false,
		spatial: false,
		auto: false
	},
	autoStretch: {
		params: {
			method: {
				type: "enum",
				values: [
					"percentClip",
					"minMax",
					"standardDeviation"
				],
				default: "percentClip"
			},
			lowPercent: {
				type: "number",
				min: 0,
				max: 50,
				default: .5,
				step: .1
			},
			highPercent: {
				type: "number",
				min: 0,
				max: 50,
				default: .5,
				step: .1
			},
			stdDevs: {
				type: "number",
				min: .1,
				max: 10,
				default: 2,
				step: .1
			},
			linked: {
				type: "boolean",
				default: false
			}
		},
		value: null,
		colorOnly: false,
		spatial: false,
		auto: true
	},
	sharpen: {
		params: {
			amount: {
				type: "number",
				min: 0,
				max: 5,
				default: .5,
				step: .05
			},
			radius: {
				type: "number",
				min: .1,
				max: 50,
				default: 1,
				step: .1
			},
			threshold: {
				type: "number",
				min: 0,
				max: 1,
				default: 0,
				step: 1 / 255
			}
		},
		value: "amount",
		colorOnly: false,
		spatial: true,
		auto: false
	}
};
/** The number parameter `param` of `op` (internal: the table is known to have it). */
function numberParam(op, param) {
	return opInfo[op].params[param];
}
//#endregion
export { numberParam, opInfo };

//# sourceMappingURL=info.js.map