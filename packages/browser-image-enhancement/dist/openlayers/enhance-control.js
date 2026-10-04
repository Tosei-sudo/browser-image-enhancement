import { opInfo } from "../ops/info.js";
import { pipeline } from "../pipeline.js";
import EnhancedGeoTIFF from "./enhanced-geotiff.js";
import GpuCorrectedTileLayer from "./gpu-layer.js";
import { addControlStyles, iconButton } from "./control-styles.js";
import { listen } from "ol/events.js";
import { unByKey } from "ol/Observable.js";
import Control from "ol/control/Control.js";
//#region src/openlayers/enhance-control.ts
/**
* OpenLayers control with the correction sliders: a button on the map that
* opens a panel of sliders (built from `opInfo`), a DRA switch and a reset
* button, and band selects that pick the bands R, G and B show. It drives the
* pipeline of an {@link EnhancedGeoTIFF} (or the {@link TileCorrection} of a
* layer of picture tiles), directly or through a layer, and refreshes DRA when
* the map stops moving.
*/
/** English texts (the default). */
const enhanceLabelsEn = {
	toggle: "Image adjustments",
	enabled: "Adjust",
	reset: "Reset",
	dra: "DRA (fit range to view)",
	"dra.enabled": "On",
	"dra.method": "Method",
	"dra.percentClip": "Percent clip",
	"dra.minMax": "Min–max",
	"dra.standardDeviation": "Std. deviation (±2σ)",
	"dra.clip": "Clip (%)",
	"dra.linked": "Link RGB",
	"dra.locked": "Lock range",
	adjustments: "Adjustments",
	bands: "Bands",
	"bands.r": "Red",
	"bands.g": "Green",
	"bands.b": "Blue",
	"bands.band": "Band {n}",
	"bands.named": "Band {n} ({name})",
	opacity: "Opacity",
	exposure: "Exposure (EV)",
	brightness: "Brightness",
	contrast: "Contrast",
	gamma: "Gamma",
	"levels.inBlack": "Black point",
	"levels.inWhite": "White point",
	"levels.gamma": "Midtones",
	temperature: "Temperature",
	saturation: "Saturation",
	sharpen: "Sharpen",
	"sharpen.radius": "Sharpen radius",
	"sharpen.threshold": "Sharpen threshold"
};
/** Japanese texts. */
const enhanceLabelsJa = {
	toggle: "画像補正",
	enabled: "補正",
	reset: "リセット",
	dra: "DRA（表示範囲で自動レンジ）",
	"dra.enabled": "オン",
	"dra.method": "方式",
	"dra.percentClip": "パーセントクリップ",
	"dra.minMax": "最小〜最大",
	"dra.standardDeviation": "標準偏差（±2σ）",
	"dra.clip": "クリップ (%)",
	"dra.linked": "RGB 連動",
	"dra.locked": "範囲を固定",
	adjustments: "補正",
	bands: "バンド割当",
	"bands.r": "R（赤）",
	"bands.g": "G（緑）",
	"bands.b": "B（青）",
	"bands.band": "バンド {n}",
	"bands.named": "バンド {n} ({name})",
	opacity: "不透明度",
	exposure: "露出 (EV)",
	brightness: "明るさ",
	contrast: "コントラスト",
	gamma: "ガンマ",
	"levels.inBlack": "レベル 黒",
	"levels.inWhite": "レベル 白",
	"levels.gamma": "レベル 中間",
	temperature: "色温度",
	saturation: "彩度",
	sharpen: "シャープ 量",
	"sharpen.radius": "シャープ 半径",
	"sharpen.threshold": "シャープ しきい値"
};
/** The sliders shown when `sliders` is not given, with ranges that suit a slider. */
const defaultEnhanceSliders = [
	{
		op: "exposure",
		min: -3,
		max: 3
	},
	{ op: "brightness" },
	{ op: "contrast" },
	{
		op: "gamma",
		min: .2,
		max: 3
	},
	{
		op: "levels",
		param: "inBlack",
		max: .5,
		step: .005
	},
	{
		op: "levels",
		param: "inWhite",
		min: .5,
		step: .005
	},
	{
		op: "levels",
		param: "gamma",
		min: .2,
		max: 3
	},
	{ op: "temperature" },
	{ op: "saturation" },
	{
		op: "sharpen",
		max: 3
	},
	{
		op: "sharpen",
		param: "radius",
		min: .3,
		max: 5
	}
];
/**
* A map control with correction sliders for an {@link EnhancedGeoTIFF}. Fires
* `change` after each new pipeline.
*
* @example
* ```ts
* const layer = new GpuCorrectedTileLayer({ source: new EnhancedGeoTIFF({ sources: [{ url }], correctTiles: false }) });
* map.addLayer(layer);
* map.addControl(new EnhanceControl({ layer, labels: enhanceLabelsJa }));
* ```
*/
var EnhanceControl = class extends Control {
	layer_;
	source_;
	rows_ = [];
	labels_;
	onChange_;
	panel_;
	toggle_;
	enabled_;
	dra_;
	draDefaults_;
	bands_;
	pipeline_ = pipeline();
	frame_ = 0;
	mapKeys_ = [];
	sourceKeys_ = [];
	layerKey_ = null;
	constructor(options = {}) {
		const element = document.createElement("div");
		super({
			element,
			target: options.target
		});
		if (options.css !== false) addControlStyles();
		element.className = `ol-enhance ol-unselectable ol-control${options.className ? ` ${options.className}` : ""}`;
		this.layer_ = options.layer ?? null;
		this.source_ = options.source ?? null;
		this.labels_ = {
			...enhanceLabelsEn,
			...options.labels
		};
		this.onChange_ = options.onChange;
		const t = (key) => this.labels_[key] ?? key;
		this.toggle_ = iconButton(t("toggle"), SLIDERS_ICON);
		this.panel_ = document.createElement("div");
		this.panel_.className = "ol-enhance-panel";
		this.panel_.id = `ol-enhance-${++panelCount}`;
		this.toggle_.setAttribute("aria-controls", this.panel_.id);
		this.toggle_.addEventListener("click", () => this.setCollapsed(!this.getCollapsed()));
		element.append(this.toggle_, this.panel_);
		const head = document.createElement("div");
		head.className = "ol-enhance-head";
		const enabledLabel = document.createElement("label");
		this.enabled_ = checkbox(true);
		enabledLabel.append(this.enabled_, t("enabled"));
		const reset = document.createElement("button");
		reset.type = "button";
		reset.textContent = t("reset");
		reset.addEventListener("click", () => this.reset());
		head.append(enabledLabel, reset);
		this.panel_.append(head);
		this.enabled_.addEventListener("change", () => this.schedule_());
		if (this.layer_ && options.opacity !== false) {
			const layer = this.layer_;
			const opacity = sliderRow(t("opacity"), 0, 1, .01, layer.getOpacity(), 2);
			opacity.input.addEventListener("input", () => {
				opacity.output.value = Number(opacity.input.value).toFixed(2);
				layer.setOpacity(Number(opacity.input.value));
			});
			this.panel_.append(opacity.row);
		}
		this.draDefaults_ = {
			enabled: false,
			method: "percentClip",
			clip: .5,
			linked: false,
			...options.draSettings
		};
		if (options.dra !== false) {
			const set = fieldset(t("dra"));
			const d = this.draDefaults_;
			const enabled = checkbox(d.enabled);
			const method = document.createElement("select");
			for (const m of [
				"percentClip",
				"minMax",
				"standardDeviation"
			]) method.add(new Option(t(`dra.${m}`), m));
			method.value = d.method;
			const clip = sliderRow(t("dra.clip"), 0, 5, .05, d.clip, 2);
			const linked = checkbox(d.linked);
			const locked = checkbox(false);
			locked.dataset.dra = "locked";
			set.append(plainRow(t("dra.enabled"), enabled), plainRow(t("dra.method"), method), clip.row, plainRow(t("dra.linked"), linked), plainRow(t("dra.locked"), locked));
			this.panel_.append(set);
			this.dra_ = {
				enabled,
				method,
				clip: clip.input,
				linked,
				locked
			};
			for (const el of [
				enabled,
				method,
				linked
			]) el.addEventListener("change", () => this.schedule_());
			locked.addEventListener("change", () => {
				const source = this.getSource();
				if (!source) return;
				source.setDraLocked(locked.checked);
				const map = this.getMap();
				if (!locked.checked && map) source.updateDra(map);
			});
			clip.input.addEventListener("input", () => {
				clip.output.value = Number(clip.input.value).toFixed(2);
				this.schedule_();
			});
		} else this.dra_ = null;
		if (options.bands !== false) {
			const set = fieldset(t("bands"));
			set.className = "ol-enhance-bands";
			set.hidden = true;
			const selects = [
				"r",
				"g",
				"b"
			].map((c) => {
				const select = document.createElement("select");
				set.append(plainRow(t(`bands.${c}`), select));
				select.addEventListener("change", () => this.applyBands_());
				return select;
			});
			this.panel_.append(set);
			this.bands_ = {
				set,
				selects
			};
		} else this.bands_ = null;
		const adjustments = fieldset(t("adjustments"));
		for (const s of options.sliders ?? defaultEnhanceSliders) {
			const info = opInfo[s.op];
			const param = s.param ?? info?.value;
			const p = param ? info?.params[param] : void 0;
			if (!param || !p || p.type !== "number") throw new TypeError(`${s.op}${param ? `.${param}` : ""} is not a number parameter.`);
			const num = p;
			const slider = {
				op: s.op,
				param,
				min: s.min ?? num.min,
				max: s.max ?? num.max,
				step: s.step ?? num.step,
				value: s.value ?? (s.op === "sharpen" && param === "amount" ? 0 : num.default)
			};
			const decimals = Math.min(3, Math.max(0, -Math.floor(Math.log10(slider.step) + 1e-9)));
			const { row, input, output } = sliderRow(s.label ?? this.labels_[param === info.value ? s.op : `${s.op}.${param}`] ?? `${s.op}.${param}`, slider.min, slider.max, slider.step, slider.value, decimals);
			const entry = {
				slider,
				input,
				output,
				row,
				decimals
			};
			input.addEventListener("input", () => {
				output.value = Number(input.value).toFixed(decimals);
				this.schedule_();
			});
			row.firstElementChild.addEventListener("dblclick", () => {
				this.setRow_(entry, slider.value);
				this.schedule_();
			});
			this.rows_.push(entry);
			adjustments.append(row);
		}
		this.panel_.append(adjustments);
		this.pipeline_ = this.build_();
		this.setCollapsed(options.collapsed ?? true);
		if (this.layer_) this.layerKey_ = this.layer_.on("change:source", () => this.bindSource_());
		this.bindSource_();
	}
	/**
	* What is being corrected: `source`, or the layer's source when it is an
	* {@link EnhancedGeoTIFF}, or else the layer's {@link TileCorrection}.
	*/
	getSource() {
		if (this.source_) return this.source_;
		const s = this.layer_?.getSource();
		if (s instanceof EnhancedGeoTIFF) return s;
		return this.layer_ instanceof GpuCorrectedTileLayer ? this.layer_.getCorrection() : null;
	}
	/** Corrects `source` instead (only when the control was not given a `layer`). */
	setSource(source) {
		this.source_ = source;
		this.bindSource_();
	}
	/** The correction the sliders set now. */
	getPipeline() {
		return this.pipeline_;
	}
	/**
	* Moves the sliders (and DRA) to the values of `p`, for example a saved
	* preset (`Pipeline.fromJSON`). Steps without a slider are left out.
	*/
	setPipeline(p) {
		for (const row of this.rows_) {
			const v = p.get(row.slider.op)?.[row.slider.param];
			this.setRow_(row, typeof v === "number" ? v : row.slider.value);
		}
		if (this.dra_) {
			const auto = p.get("autoStretch");
			this.dra_.enabled.checked = !!auto;
			if (auto) {
				this.dra_.method.value = auto.method;
				this.dra_.clip.value = String(auto.lowPercent);
				this.dra_.clip.nextElementSibling.value = auto.lowPercent.toFixed(2);
				this.dra_.linked.checked = auto.linked;
			}
		}
		this.enabled_.checked = true;
		this.schedule_();
	}
	/** Puts every slider back to its neutral value (DRA to its starting settings). */
	reset() {
		for (const row of this.rows_) this.setRow_(row, row.slider.value);
		if (this.dra_) {
			const d = this.draDefaults_;
			this.dra_.enabled.checked = d.enabled;
			this.dra_.method.value = d.method;
			this.dra_.clip.value = String(d.clip);
			this.dra_.clip.nextElementSibling.value = d.clip.toFixed(2);
			this.dra_.linked.checked = d.linked;
		}
		this.enabled_.checked = true;
		this.schedule_();
	}
	/** Whether the panel is closed. */
	getCollapsed() {
		return this.panel_.hidden;
	}
	/** Opens (false) or closes (true) the panel. */
	setCollapsed(collapsed) {
		this.panel_.hidden = collapsed;
		this.toggle_.setAttribute("aria-expanded", String(!collapsed));
		this.element.classList.toggle("ol-collapsed", collapsed);
	}
	setMap(map) {
		unByKey(this.mapKeys_);
		this.mapKeys_ = [];
		super.setMap(map);
		if (map) this.mapKeys_.push(map.on("moveend", () => void this.getSource()?.updateDra(map)));
	}
	disposeInternal() {
		cancelAnimationFrame(this.frame_);
		unByKey(this.mapKeys_);
		unByKey(this.sourceKeys_);
		if (this.layerKey_) unByKey(this.layerKey_);
		super.disposeInternal();
	}
	/** Gives a newly set source the current correction, and follows its color mode. */
	bindSource_() {
		unByKey(this.sourceKeys_);
		this.sourceKeys_ = [];
		const source = this.getSource();
		this.updateColorRows_();
		this.updateBands_();
		if (this.dra_) this.dra_.locked.checked = source?.isDraLocked() ?? false;
		if (!source) return;
		this.apply_(source);
		this.sourceKeys_.push(listen(source, "change", () => {
			if (source.getState() !== "ready") return;
			this.updateColorRows_();
			this.updateBands_();
			const map = this.getMap();
			if (map && !source.getDraInfo()) source.updateDra(map);
		}));
	}
	/** Band choices for the source's band count, showing the bands it draws now. */
	updateBands_() {
		const b = this.bands_;
		if (!b) return;
		const source = this.getSource();
		const n = source?.getValueBandCount() ?? 0;
		b.set.hidden = n < 3;
		if (n < 3) return;
		const current = source.getSelect() ?? [
			0,
			1,
			2
		];
		b.selects.forEach((select, c) => {
			if (select.options.length !== n) select.replaceChildren(...Array.from({ length: n }, (_, i) => new Option(this.bandLabel_(i, null), String(i))));
			select.value = String(current[c]);
		});
		source.getBandNames().then((names) => {
			if (this.getSource() !== source) return;
			for (const select of b.selects) for (const option of select.options) option.text = this.bandLabel_(Number(option.value), names[Number(option.value)] ?? null);
		});
	}
	/** "Band 4" or, with a name, "Band 4 (NIR)". */
	bandLabel_(band, name) {
		const n = String(band + 1);
		return name ? this.labels_["bands.named"].replace("{n}", n).replace("{name}", () => name) : this.labels_["bands.band"].replace("{n}", n);
	}
	/** Sends the chosen bands to the source. */
	applyBands_() {
		const source = this.getSource();
		if (!source || !this.bands_) return;
		const [r, g, b] = this.bands_.selects.map((s) => Number(s.value));
		source.setSelect([
			r,
			g,
			b
		]).then(() => {
			const map = this.getMap();
			if (map) source.updateDra(map);
		});
		this.updateColorRows_();
	}
	updateColorRows_() {
		const gray = this.getSource()?.getColorMode() === "gray";
		for (const row of this.rows_) row.row.hidden = gray && opInfo[row.slider.op].colorOnly;
	}
	setRow_(row, value) {
		row.input.value = String(value);
		row.output.value = Number(row.input.value).toFixed(row.decimals);
	}
	/** Slider moves are coalesced to one new pipeline per frame. */
	schedule_() {
		if (this.frame_) return;
		this.frame_ = requestAnimationFrame(() => {
			this.frame_ = 0;
			this.pipeline_ = this.build_();
			const source = this.getSource();
			if (source) this.apply_(source);
			this.onChange_?.(this.pipeline_);
			this.changed();
		});
	}
	apply_(source) {
		source.setPipeline(this.pipeline_);
		const map = this.getMap();
		if (map) source.updateDra(map);
	}
	build_() {
		if (!this.enabled_.checked) return pipeline();
		let p = pipeline();
		const d = this.dra_;
		if (d?.enabled.checked) {
			const clip = Number(d.clip.value);
			p = p.autoStretch({
				method: d.method.value,
				lowPercent: clip,
				highPercent: clip,
				linked: d.linked.checked
			});
		}
		const steps = /* @__PURE__ */ new Map();
		for (const { slider, input } of this.rows_) {
			const params = steps.get(slider.op) ?? {};
			params[slider.param] = Number(input.value);
			steps.set(slider.op, params);
		}
		for (const [op, params] of steps) if (!pipeline().set(op, params).isIdentity) p = p.set(op, params);
		return p;
	}
};
let panelCount = 0;
const SLIDERS_ICON = "M3 5h8M15 5h2M3 10h2M9 10h8M3 15h10M17 15h0M13 3v4M7 8v4M15 13v4";
function checkbox(checked) {
	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	return input;
}
function fieldset(legend) {
	const set = document.createElement("fieldset");
	const l = document.createElement("legend");
	l.textContent = legend;
	set.append(l);
	return set;
}
function plainRow(label, control) {
	const row = document.createElement("label");
	row.className = "ol-enhance-row";
	const name = document.createElement("span");
	name.textContent = label;
	row.append(name, control);
	if (!(control instanceof HTMLSelectElement)) row.append(document.createElement("span"));
	return row;
}
function sliderRow(label, min, max, step, value, decimals) {
	const row = document.createElement("label");
	row.className = "ol-enhance-row";
	const name = document.createElement("span");
	name.textContent = label;
	const input = document.createElement("input");
	input.type = "range";
	input.min = String(min);
	input.max = String(max);
	input.step = String(step);
	input.value = String(value);
	const output = document.createElement("output");
	output.value = Number(input.value).toFixed(decimals);
	row.append(name, input, output);
	return {
		row,
		input,
		output
	};
}
//#endregion
export { EnhanceControl as default, defaultEnhanceSliders, enhanceLabelsEn, enhanceLabelsJa };

//# sourceMappingURL=enhance-control.js.map