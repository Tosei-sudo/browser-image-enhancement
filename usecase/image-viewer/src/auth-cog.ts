/**
 * COGs opened by URL with `config.json`'s access rules (auth.ts): the image
 * is read from the URL with the rule's query parameters and with its headers
 * (geotiff.js sends them with every range request), while the layer keeps the
 * URL as given, so neither shows up in the layer's name, links or projects.
 */
import { LoadImageControl, type LoadImageControlOptions } from 'browser-image-enhancement/openlayers';
import { authorize } from './auth.js';

/** The headers of the COG being opened, while its source is made. */
let opening: Record<string, string> | null = null;

/** A {@link LoadImageControl} whose `loadUrl` applies the access rules. */
export class AuthLoadImageControl extends LoadImageControl {
  /** The URL as given, by the URL read. */
  private readonly names_: Map<string, string>;

  constructor(options: LoadImageControlOptions) {
    const names = new Map<string, string>();
    const shown = (name: string) => names.get(name) ?? name;
    const base = options.sourceOptions;
    super({
      ...options,
      // Read each time a source is made (synchronously inside loadUrl), so it carries the headers of that COG.
      sourceOptions: {
        ...base,
        get sourceOptions() {
          return opening ? { ...base?.sourceOptions, headers: { ...base?.sourceOptions?.headers, ...opening } } : base?.sourceOptions;
        },
      },
      onLoad: options.onLoad && ((loaded) => options.onLoad!({ ...loaded, name: shown(loaded.name) })),
      onError: options.onError && ((error, name) => options.onError!(error, shown(name))),
    });
    this.names_ = names;
  }

  override loadUrl(url: string): ReturnType<LoadImageControl['loadUrl']> {
    const { url: target, headers } = authorize(url);
    if (target === url && !Object.keys(headers).length) return super.loadUrl(url);
    if (target !== url) this.names_.set(target, url);
    opening = Object.keys(headers).length ? headers : null;
    try {
      // The source is made before loadUrl first awaits.
      return super.loadUrl(target);
    } finally {
      opening = null;
    }
  }
}
