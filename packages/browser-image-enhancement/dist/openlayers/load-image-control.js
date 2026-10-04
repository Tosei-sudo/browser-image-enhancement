import { toImageData } from "../workers/src/io.js";
import EnhancedGeoTIFF from "./enhanced-geotiff.js";
import GpuCorrectedTileLayer from "./gpu-layer.js";
import { addControlStyles, iconButton } from "./control-styles.js";
import { imageToGeoTIFF } from "./geotiff-writer.js";
import { getCenter, getHeight, getWidth } from "ol/extent.js";
import { transformExtent } from "ol/proj.js";
import { unByKey } from "ol/Observable.js";
import Control from "ol/control/Control.js";
import BaseEvent from "ol/events/Event.js";
//#region src/openlayers/load-image-control.ts
/**
* OpenLayers control that loads an image onto the map: a GeoTIFF / COG from a
* local file or a URL, placed where its georeferencing says, or an ordinary
* picture (PNG, JPEG, WebP, ...), placed over the current view. Files can also
* be dropped on the map. Every image becomes an {@link EnhancedGeoTIFF}, so
* the {@link EnhanceControl}, DRA and the GPU layer work the same on both.
*/
/** Fired by {@link LoadImageControl}: `load` with {@link LoadImageEvent.loaded}, `error` with {@link LoadImageEvent.error}. */
var LoadImageEvent = class extends BaseEvent {
	loaded;
	error;
	name;
	constructor(type, loaded, error = null, name = loaded?.name ?? "") {
		super(type);
		this.loaded = loaded;
		this.error = error;
		this.name = name;
	}
};
/** English texts (the default). */
const loadImageLabelsEn = {
	open: "Open an image or GeoTIFF",
	url: "Open a COG URL",
	urlPlaceholder: "https://…/image.tif",
	load: "Open"
};
/** Japanese texts. */
const loadImageLabelsJa = {
	open: "画像または GeoTIFF を開く",
	url: "COG の URL を開く",
	urlPlaceholder: "https://…/image.tif",
	load: "開く"
};
/**
* A map control that opens images and GeoTIFFs (file chooser, URL, or drag
* and drop) as {@link EnhancedGeoTIFF} sources.
*
* @example
* ```ts
* const layer = new GpuCorrectedTileLayer();
* map.addLayer(layer);
* map.addControl(new LoadImageControl({ layer }));
* map.addControl(new EnhanceControl({ layer }));
* ```
*/
var LoadImageControl = class extends Control {
	options_;
	file_;
	undrop_ = [];
	busy_ = 0;
	constructor(options = {}) {
		const element = document.createElement("div");
		super({
			element,
			target: options.target
		});
		if (options.css !== false) addControlStyles();
		this.options_ = options;
		element.className = `ol-load-image ol-unselectable ol-control${options.className ? ` ${options.className}` : ""}`;
		const t = {
			...loadImageLabelsEn,
			...options.labels
		};
		this.file_ = document.createElement("input");
		this.file_.type = "file";
		this.file_.accept = options.accept ?? ".tif,.tiff,image/*";
		this.file_.hidden = true;
		this.file_.multiple = !!options.onFiles;
		this.file_.addEventListener("change", () => {
			const files = Array.from(this.file_.files ?? []);
			this.file_.value = "";
			this.takeFiles_(files);
		});
		const open = iconButton(t.open, FOLDER_ICON);
		open.addEventListener("click", () => options.onOpen ? options.onOpen() : this.openChooser());
		element.append(open, this.file_);
		if (options.url !== false) {
			const toggle = iconButton(t.url, LINK_ICON);
			const form = document.createElement("form");
			form.hidden = true;
			const input = document.createElement("input");
			input.type = "url";
			input.required = true;
			input.placeholder = t.urlPlaceholder;
			input.setAttribute("aria-label", t.url);
			const submit = document.createElement("button");
			submit.type = "submit";
			submit.textContent = t.load;
			form.append(input, submit);
			toggle.setAttribute("aria-expanded", "false");
			toggle.addEventListener("click", () => {
				form.hidden = !form.hidden;
				toggle.setAttribute("aria-expanded", String(!form.hidden));
				if (!form.hidden) input.focus();
			});
			form.addEventListener("submit", (e) => {
				e.preventDefault();
				const url = input.value.trim();
				if (url) this.loadUrl(url).then(() => form.hidden = true, () => {});
			});
			element.append(toggle, form);
		}
	}
	/** Opens the browser's file chooser, as the open button does without `onOpen`. */
	openChooser() {
		this.file_.click();
	}
	/** Whether a load is in progress. */
	isLoading() {
		return this.busy_ > 0;
	}
	/**
	* Loads a GeoTIFF, or an ordinary picture placed over the view. Resolves
	* with the new source once it is on the layer (and the map fitted to it).
	*/
	async loadFile(file, name = file instanceof File ? file.name : "image") {
		return this.track_(name, async () => {
			if (await isTiff(file)) return this.show_({ blob: file }, name, "geotiff");
			const map = this.getMap();
			if (!map) throw new Error("Add the control to a map before loading an ordinary image (it is placed over the view).");
			const image = await toImageData(file);
			const { extent, epsg } = (this.options_.placement ?? placeOverView)({
				width: image.width,
				height: image.height
			}, map);
			return this.show_({ blob: imageToGeoTIFF(image, {
				extent,
				epsg
			}) }, name, "image");
		});
	}
	/** Loads a COG (or any GeoTIFF the server allows range requests on) from `url`. */
	async loadUrl(url) {
		return this.track_(url, () => this.show_({ url }, url, "geotiff"));
	}
	setMap(map) {
		this.undrop_.forEach((off) => off());
		this.undrop_ = [];
		super.setMap(map);
		if (!map || this.options_.drop === false) return;
		const viewport = map.getViewport();
		const over = (e) => {
			if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
			e.preventDefault();
			viewport.classList.add("ol-load-image-drop");
		};
		const leave = () => viewport.classList.remove("ol-load-image-drop");
		const drop = (e) => {
			leave();
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (!files.length) return;
			e.preventDefault();
			this.takeFiles_(files);
		};
		const on = (type, fn) => {
			viewport.addEventListener(type, fn);
			this.undrop_.push(() => viewport.removeEventListener(type, fn));
		};
		on("dragenter", over);
		on("dragover", over);
		on("dragleave", leave);
		on("drop", drop);
	}
	/** Chosen or dropped files: to `onFiles`, else the first one is opened. */
	takeFiles_(files) {
		if (this.options_.onFiles) {
			if (files.length) this.options_.onFiles(files);
		} else if (files[0]) this.loadFile(files[0]).catch(() => {});
	}
	disposeInternal() {
		this.undrop_.forEach((off) => off());
		this.undrop_ = [];
		super.disposeInternal();
	}
	async track_(name, load) {
		this.busy_++;
		this.element.classList.add("ol-load-image-busy");
		this.element.setAttribute("aria-busy", "true");
		try {
			return await load();
		} catch (error) {
			this.options_.onError?.(error, name);
			this.dispatchEvent(new LoadImageEvent("error", null, error, name));
			throw error;
		} finally {
			if (--this.busy_ === 0) {
				this.element.classList.remove("ol-load-image-busy");
				this.element.removeAttribute("aria-busy");
			}
		}
	}
	async show_(from, name, kind) {
		const layer = this.options_.layer;
		const previous = layer?.getSource();
		const onGpu = layer instanceof GpuCorrectedTileLayer && layer.hasGpu();
		const source = new EnhancedGeoTIFF({
			pipeline: previous instanceof EnhancedGeoTIFF ? previous.getPipeline() : void 0,
			correctTiles: !onGpu,
			normalize: "auto",
			rawStretch: {
				lowPercent: 2,
				highPercent: 2
			},
			...this.options_.sourceOptions,
			sources: [from]
		});
		let view;
		try {
			view = await viewOf(source);
		} catch (error) {
			source.dispose();
			throw error instanceof Error ? error : new Error(String(error));
		}
		if (layer) {
			const current = layer.getSource();
			layer.setSource(source);
			if (current && current !== source) current.dispose();
		}
		const map = this.getMap();
		if (map && this.options_.fit !== false && view.extent) {
			const target = map.getView();
			const extent = transformExtent(view.extent, view.projection ?? "EPSG:4326", target.getProjection());
			target.fit(extent, {
				padding: [
					20,
					20,
					20,
					20
				],
				duration: 0
			});
		}
		const loaded = {
			source,
			name,
			kind
		};
		this.options_.onLoad?.(loaded);
		this.dispatchEvent(new LoadImageEvent("load", loaded));
		return source;
	}
};
/**
* The source's view, or its error. OpenLayers' `getView()` never settles when
* the GeoTIFF cannot be read (a 404, CORS, not a TIFF): the source only goes
* to the `error` state.
*/
function viewOf(source) {
	return new Promise((resolve, reject) => {
		const failed = () => {
			if (source.getState() !== "error") return false;
			unByKey(key);
			reject(source.getError() ?? /* @__PURE__ */ new Error("The GeoTIFF could not be read."));
			return true;
		};
		const key = source.on("change", failed);
		if (failed()) return;
		source.getView().then((view) => {
			unByKey(key);
			resolve(view);
		}, (error) => {
			unByKey(key);
			reject(error);
		});
	});
}
/** The default placement: centered on the view, 80 % of it, keeping the picture's shape. */
function placeOverView(size, map) {
	const view = map.getView();
	const mapSize = map.getSize() ?? [512, 512];
	const projection = view.getProjection();
	let extent = view.calculateExtent(mapSize);
	let epsg = epsgCode(projection.getCode());
	if (epsg === null) {
		extent = transformExtent(extent, projection, "EPSG:3857");
		epsg = 3857;
	}
	const scale = Math.min(.8 * getWidth(extent) / size.width, .8 * getHeight(extent) / size.height);
	const [cx, cy] = getCenter(extent);
	const w = size.width * scale / 2;
	const h = size.height * scale / 2;
	return {
		extent: [
			cx - w,
			cy - h,
			cx + w,
			cy + h
		],
		epsg
	};
}
function epsgCode(code) {
	if (code === "CRS:84") return 4326;
	const m = /^(?:EPSG:|urn:ogc:def:crs:EPSG:[^:]*:|http:\/\/www\.opengis\.net\/def\/crs\/EPSG\/0\/)(\d+)$/.exec(code);
	if (!m) return null;
	const n = Number(m[1]);
	if (n === 900913 || n === 102100 || n === 102113) return 3857;
	return n <= 65535 ? n : null;
}
/** TIFF magic number: "II*\0" or "MM\0*" (BigTIFF has 43 in place of 42). */
async function isTiff(file) {
	const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
	return b[0] === 73 && b[1] === 73 && (b[2] === 42 || b[2] === 43) && b[3] === 0 || b[0] === 77 && b[1] === 77 && b[2] === 0 && (b[3] === 42 || b[3] === 43);
}
const FOLDER_ICON = "M2 5.5A1.5 1.5 0 0 1 3.5 4h4l1.5 2h7.5A1.5 1.5 0 0 1 18 7.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 15.5z";
const LINK_ICON = "M8.5 11.5l3-3M7 9.5l-1.6 1.6a2.5 2.5 0 0 0 3.5 3.5L10.5 13M13 10.5l1.6-1.6a2.5 2.5 0 0 0-3.5-3.5L9.5 7";
//#endregion
export { LoadImageEvent, LoadImageControl as default, loadImageLabelsEn, loadImageLabelsJa, placeOverView };

//# sourceMappingURL=load-image-control.js.map