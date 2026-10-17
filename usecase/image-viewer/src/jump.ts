/**
 * "Go to": a field in the header that reads latitude / longitude, MGRS or
 * UTM (see `parseCoordinate`), or a place name or address (geocode.ts),
 * centers the map there and marks the spot until the next jump. While a
 * name is typed, the places found show in a list under the field.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle, Fill, Stroke, Style } from 'ol/style.js';
import { fromLonLat, transformExtent } from 'ol/proj.js';
import { formatLatLon, parseCoordinate, type LonLat } from './coordinates.js';
import type { Place, PlaceSearch } from './geocode.js';

export interface JumpOptions {
  /** Shows a message to the user. */
  say: (message: string) => void;
  /** Where place names are looked up; none (or one with no geocoders) reads coordinates only. */
  places?: PlaceSearch;
}

/** Zoom level the map goes to at least when jumping (about 2 m per pixel in Web Mercator). */
const JUMP_ZOOM = 16;
/** How long typing pauses before places are looked up. */
const PAUSE = 350;

export class JumpTo {
  private readonly marker_ = new Feature<Point>();
  private readonly layer_: VectorLayer<VectorSource<Feature<Point>>>;
  private readonly input_: HTMLInputElement;
  private readonly list_: HTMLUListElement;
  private places_: Place[] = [];
  private active_ = -1;
  private timer_: ReturnType<typeof setTimeout> | undefined;
  private asking_: AbortController | null = null;
  /** The text the list was found for. */
  private shownFor_ = '';

  constructor(
    private readonly map: OlMap,
    form: HTMLFormElement,
    private readonly options: JumpOptions,
  ) {
    this.layer_ = new VectorLayer({
      source: new VectorSource({ features: [this.marker_] }),
      zIndex: 10_001, // above images and points
      style: new Style({
        image: new Circle({ radius: 9, fill: new Fill({ color: '#2563eb33' }), stroke: new Stroke({ color: '#2563eb', width: 3 }) }),
      }),
      visible: false,
    });
    map.addLayer(this.layer_);
    const input = (this.input_ = form.querySelector('input')!);
    this.list_ = document.createElement('ul');
    this.list_.className = 'jump-places';
    this.list_.id = 'jump-places';
    this.list_.setAttribute('role', 'listbox');
    this.list_.setAttribute('aria-label', '見つかった場所');
    this.list_.hidden = true;
    form.append(this.list_);
    if (this.searching()) {
      input.placeholder = '緯度経度・MGRS・UTM・地名・住所';
      input.setAttribute('aria-label', '座標・地名へ移動');
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-controls', this.list_.id);
      input.setAttribute('aria-expanded', 'false');
      input.setAttribute('aria-autocomplete', 'list');
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit_();
    });
    input.addEventListener('input', () => this.typed_());
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || this.list_.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const n = this.places_.length;
        if (!n) return;
        const down = e.key === 'ArrowDown';
        this.select_(this.active_ < 0 ? (down ? 0 : n - 1) : (this.active_ + (down ? 1 : n - 1)) % n);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        this.hide_();
        e.stopPropagation();
      }
    });
    input.addEventListener('blur', () => setTimeout(() => this.hide_(), 150));
    this.list_.addEventListener('pointerdown', (e) => e.preventDefault());
    this.list_.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('li');
      if (item) this.goToPlace(this.places_[Number(item.dataset.index)]);
    });
  }

  /** Whether place names are looked up. */
  searching(): boolean {
    return !!this.options.places?.enabled;
  }

  /** Goes to the coordinate in `text`; null (with a message) when it cannot be read. */
  jump(text: string): LonLat | null {
    const lonLat = parseCoordinate(text);
    if (!lonLat) {
      this.options.say(`座標として読めませんでした: ${text}（緯度経度・MGRS・UTM に対応）`);
      return null;
    }
    this.goTo_(lonLat);
    this.options.say(`移動しました: ${formatLatLon(lonLat)}`);
    return lonLat;
  }

  /** Goes to a place found by name: its extent when known, else its point. */
  goToPlace(place: Place): void {
    this.hide_();
    this.goTo_(place.lonLat, place.extent);
    this.input_.value = place.name;
    this.input_.select();
    this.options.say(`移動しました: ${place.name}（${place.source}）`);
  }

  /** Looks up `text` as a place (for tests and the console). */
  async findPlaces(text: string): Promise<Place[]> {
    if (!this.options.places?.enabled) return [];
    const { places, errors } = await this.options.places.search(text);
    if (!places.length && errors.length) this.options.say(`地名を検索できませんでした（${errors.join('、')}）`);
    return places;
  }

  private goTo_(lonLat: LonLat, extent?: Place['extent']): void {
    const view = this.map.getView();
    const center = fromLonLat(lonLat, view.getProjection());
    this.marker_.setGeometry(new Point(center));
    this.layer_.setVisible(true);
    if (extent && extent[2] > extent[0] && extent[3] > extent[1]) {
      view.fit(transformExtent(extent, 'EPSG:4326', view.getProjection()), { maxZoom: 18, duration: 300, padding: [40, 40, 40, 40] });
    } else {
      view.animate({ center, zoom: Math.max(view.getZoom() ?? 0, JUMP_ZOOM), duration: 300 });
    }
  }

  /** Enter: the chosen place, a coordinate, else the first place found for the text. */
  private async submit_(): Promise<void> {
    const text = this.input_.value.trim();
    if (!text) return;
    if (!this.list_.hidden && this.active_ >= 0 && this.shownFor_ === text) return this.goToPlace(this.places_[this.active_]);
    if (parseCoordinate(text) || !this.searching()) {
      this.hide_();
      if (this.jump(text)) this.input_.select();
      return;
    }
    clearTimeout(this.timer_);
    const places = this.shownFor_ === text && this.places_.length ? this.places_ : await this.findPlaces(text);
    if (places[0]) this.goToPlace(places[0]);
    else this.options.say(`見つかりませんでした: ${text}（緯度経度・MGRS・UTM・地名・住所に対応）`);
  }

  /** While typing a name: look it up once typing pauses. */
  private typed_(): void {
    clearTimeout(this.timer_);
    const text = this.input_.value.trim();
    if (!this.searching() || !text || parseCoordinate(text) || text.length < 2) return this.hide_();
    this.timer_ = setTimeout(() => void this.lookUp_(text), PAUSE);
  }

  private async lookUp_(text: string): Promise<void> {
    this.asking_?.abort();
    const asking = (this.asking_ = new AbortController());
    const { places } = await this.options.places!.search(text, asking.signal);
    if (asking.signal.aborted || this.input_.value.trim() !== text) return;
    this.show_(text, places);
  }

  private show_(text: string, places: Place[]): void {
    this.places_ = places;
    this.shownFor_ = text;
    this.list_.replaceChildren(
      ...places.map((p, i) => {
        const li = document.createElement('li');
        li.id = `jump-place-${i}`;
        li.setAttribute('role', 'option');
        li.dataset.index = String(i);
        const name = document.createElement('span');
        name.className = 'jump-place-name';
        name.textContent = p.name;
        const source = document.createElement('span');
        source.className = 'jump-place-source';
        source.textContent = p.source;
        li.append(name, source);
        if (p.detail) {
          const detail = document.createElement('span');
          detail.className = 'jump-place-detail';
          detail.textContent = p.detail;
          li.append(detail);
        }
        return li;
      }),
    );
    if (!places.length) {
      const li = document.createElement('li');
      li.className = 'jump-place-none';
      li.textContent = '見つかりませんでした';
      this.list_.append(li);
    }
    this.active_ = -1;
    this.list_.hidden = false;
    this.input_.setAttribute('aria-expanded', 'true');
  }

  private select_(index: number): void {
    this.list_.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
    this.active_ = index;
    const item = this.list_.children[index] as HTMLElement | undefined;
    if (!item || !this.places_[index]) return;
    item.setAttribute('aria-selected', 'true');
    item.scrollIntoView({ block: 'nearest' });
    this.input_.setAttribute('aria-activedescendant', item.id);
  }

  private hide_(): void {
    this.asking_?.abort();
    this.list_.hidden = true;
    this.active_ = -1;
    if (this.searching()) this.input_.setAttribute('aria-expanded', 'false');
    this.input_.removeAttribute('aria-activedescendant');
  }
}
