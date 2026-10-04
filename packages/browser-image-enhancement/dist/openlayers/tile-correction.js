import { pipeline } from "../pipeline.js";
import Observable from "ol/Observable.js";
//#region src/openlayers/tile-correction.ts
/**
* Pipeline and DRA statistics for a {@link GpuCorrectedTileLayer} over a
* picture tile source. Pass it as the layer's `correction`, and to an
* `EnhanceControl` (`setSource`) to drive it with the panel.
*
* @example
* ```ts
* const correction = new TileCorrection();
* const layer = new GpuCorrectedTileLayer({ source: new ImageTile({ url, crossOrigin: 'anonymous' }), correction });
* enhance.setSource(correction);
* ```
*/
var TileCorrection = class extends Observable {
	pipeline_;
	effective_;
	stats_ = null;
	info_ = null;
	wanted_ = false;
	viewKey_ = "";
	locked_ = false;
	constructor(options = {}) {
		super();
		this.pipeline_ = options.pipeline ?? pipeline();
		this.effective_ = this.pipeline_.resolve(null);
	}
	/** The correction as set, before `autoStretch` is fixed from statistics. */
	getPipeline() {
		return this.pipeline_;
	}
	/** Replaces the correction; the layer redraws (no tile is reloaded). */
	setPipeline(p) {
		this.pipeline_ = p;
		this.effective_ = p.resolve(this.stats_);
		this.changed();
	}
	/** The pipeline the map is corrected with now, with any `autoStretch` already fixed. */
	getEffectivePipeline() {
		return this.effective_;
	}
	/** Picture tiles are corrected as color. */
	getColorMode() {
		return "rgb";
	}
	/** Always false: the layer corrects the drawn map, never the tiles. */
	correctsTiles() {
		return false;
	}
	/** Always 0: picture tiles have no bands to assign. */
	getValueBandCount() {
		return 0;
	}
	/** Always null: picture tiles have no bands to assign. */
	getSelect() {
		return null;
	}
	/** Does nothing: picture tiles have no bands to assign. */
	async setSelect() {}
	/** Always `ready`. */
	getState() {
		return "ready";
	}
	/** What the current DRA statistics were taken from; null before the first statistics. */
	getDraInfo() {
		return this.info_;
	}
	/** Whether the DRA range is locked (see {@link TileCorrection.setDraLocked}). */
	isDraLocked() {
		return this.locked_;
	}
	/**
	* Locks the DRA range: `updateDra` keeps the statistics it has instead of
	* following the view. DRA settings still apply to the kept statistics.
	* Unlocking lets the next `updateDra` take the view again.
	*/
	setDraLocked(locked) {
		if (locked === this.locked_) return;
		this.locked_ = locked;
		if (!locked) this.viewKey_ = "";
		this.changed();
	}
	/**
	* Asks the layer for new DRA statistics of what `map` shows: they are taken
	* from the next frame it draws, and again once the visible tiles have
	* loaded. Call it on the map's `moveend`. Does nothing when the pipeline has
	* no `autoStretch`, the view has not changed, or the range is locked
	* ({@link TileCorrection.setDraLocked}) and already has statistics.
	*/
	async updateDra(map) {
		if (!this.pipeline_.needsStats) return;
		if (this.locked_ && this.stats_) return;
		const view = map.getView();
		const key = `${view.getCenter()?.join(",")}:${view.getResolution()}:${view.getRotation()}:${map.getSize()?.join(",")}`;
		if (key === this.viewKey_ && (this.stats_ || this.wanted_)) return;
		this.viewKey_ = key;
		this.wanted_ = true;
		this.changed();
		map.once("rendercomplete", () => {
			this.wanted_ = true;
			this.changed();
		});
	}
	/** Whether the layer should take statistics from the frame it draws next. */
	wantsStats() {
		return this.wanted_ && this.pipeline_.needsStats;
	}
	/** Called by the layer with the statistics of the frame it drew. */
	setStats(stats, info) {
		this.wanted_ = false;
		this.stats_ = stats;
		this.info_ = info;
		this.effective_ = this.pipeline_.resolve(stats);
	}
};
//#endregion
export { TileCorrection as default };

//# sourceMappingURL=tile-correction.js.map