# dashboards

Four self-contained dashboards, each reading a live public API. Every folder is
an independent page that can be deployed on its own.

| Folder | Dashboard | Data source | Credential |
|---|---|---|---|
| [`crypto/`](crypto) | Crypto Markets | CoinGecko | Optional |
| [`weather/`](weather) | Weather Forecast | OpenWeather | Required, query param |
| [`earthquakes/`](earthquakes) | Seismic Activity | USGS event catalog | None |
| [`stocks/`](stocks) | Market Watch | Finnhub | Required, query param |

Each folder holds one `index.html` plus its `app.js` and shares the code in
[`shared/`](shared).

## Stack

Preact with `htm`, loaded from a CDN as a UMD bundle. Components and hooks, no
build step, no `node_modules`, nothing to compile before pushing — the files in
this repository are the files that run.

That is deliberate. These pages are written to be served by a host that fetches
the entry document, inlines the same-repo `<script src>` and `<link
rel=stylesheet>` files it names, and serves the result in a sandboxed frame.
Nothing runs a bundler, so a repository that needed building would have to
commit its own `dist/` and could silently ship a stale one. This one cannot go
stale.

Charts are hand-rolled SVG in [`shared/charts.js`](shared/charts.js). They read
their colours from the same CSS custom properties as the page chrome, so light
and dark are one token swap rather than two sets of chart options.

## Layout

```
shared/theme.css    design tokens, layout, light + dark
shared/lib.js       fetch, hooks, scales, formatters
shared/charts.js    chart, map and UI components
shared/world.js     world land outlines (earthquakes only)
<folder>/index.html entry document — lists its scripts in order
<folder>/app.js     the dashboard itself
```

`shared/` is loaded through relative `<script src="../shared/...">` tags rather
than ES module `import`s. An inliner that follows `<script src>` does not follow
`import`, and the document it produces runs with no origin for a relative
specifier to resolve against — so each shared file is a classic script that
hangs itself off one global (`DB`, `DBUI`, `DBWorld`), and each entry document
lists them in dependency order.

## Running locally

Any static file server from the repository root, then open a folder:

```bash
npx --yes http-server . -p 4322
```

The keyless dashboard (`earthquakes/`) works immediately. The others make their
first call, get refused, and show a card asking for an API key, which is kept in
`localStorage` for that browser only and is never sent anywhere but the API it
belongs to.

## Deploying

Each folder is its own entry point:

| Dashboard | Entry file | API host | Credential | Variable |
|---|---|---|---|---|
| Crypto Markets | `crypto/index.html` | `api.coingecko.com` | header `x-cg-demo-api-key` | `COINGECKO_API_KEY` (optional) |
| Weather Forecast | `weather/index.html` | `api.openweathermap.org` | query `appid` | `OPENWEATHER_API_KEY` |
| Seismic Activity | `earthquakes/index.html` | `earthquake.usgs.gov` | none | none |
| Market Watch | `stocks/index.html` | `finnhub.io` | query `token` | `FINNHUB_API_KEY` |

If the pages are served inside a sandboxed frame that narrows outbound calls to
an approved list, **every dashboard needs its API host on that list, including
the keyless one**. A call to an unlisted host fails at the network layer with no
HTTP status at all. Being reachable and having a credential attached are
separate things; `earthquakes/` needs the first and not the second.

### Where the keys live

Three arrangements work, and the same source handles all of them without
branching on which one it is in.

**A host-side credential proxy.** Register the key as a **secret** and let the
proxy attach it after the request leaves the browser. This is the arrangement to
prefer: nothing in the document the browser receives contains the key.

**A substituted variable.** A host that rewrites `%NAME%` placeholders in the
source can supply the key that way. Note that this puts the key in front of
anyone who opens the page, so it suits a keyless-by-courtesy API far better than
a billable one.

**Pasted locally.** With neither of the above, the first call comes back
unauthorised and the page asks for a key, holding it in that browser's
`localStorage`.

The code is written so these collapse into one path. Each dashboard declares its
key as a `%NAME%` placeholder and treats an unsubstituted placeholder as "no
key", and `DB.query` drops empty parameters — so with no key in hand the request
simply goes out without an `appid`/`token` for a proxy to add. The key prompt is
triggered by an actual `401`/`403`, never by the mere absence of a key, because
absence is the correct state when something upstream is supplying it.

## The seismic map

`earthquakes/` plots events on a pannable, zoomable world map. It is inline SVG
over land outlines committed to this repository ([`shared/world.js`](shared/world.js),
Natural Earth 1:110m, public domain), not a tile layer.

That is a deliberate trade. A tile-based map would fetch a few hundred images
per session from a third-party tile server — the exact runtime asset fetching
the rest of this repo avoids, and the failure mode inside a locked-down frame is
a grey rectangle with nothing in the console to explain it. Committed geometry
always renders, themes with the rest of the page, and carries no tile-usage
policy or attribution requirement into a deployment. The cost is 65KB in the
repository and no street-level detail, neither of which matters for plotting
global seismicity.

Land sits in a transformed group so panning costs one attribute rather than
rebuilding a 5,000-point path, and the marks are projected separately so a
circle keeps its size at every zoom — a marker that scaled with the map would be
encoding the zoom level as well as the magnitude.

## Notes on the charts

- **One axis, always.** No chart here has two y-scales. The crypto seven-day
  comparison rebases every coin to 100 so that coins trading four orders of
  magnitude apart share one scale honestly.
- **Colour by the job it does.** Categorical hues are assigned in fixed order
  and never cycled, and hiding a series never repaints the survivors. Magnitude
  bands and gain/loss use reserved status and polarity colours, always beside a
  printed figure, so colour never carries meaning alone.
- **Hover everywhere something is plotted** — a crosshair on the continuous
  forms, per-mark tooltips on the discrete ones — and every chart is backed by a
  sortable table of the same data.
- Light and dark are both selected palettes, not an automatic inversion, and
  follow the OS setting until the in-page toggle overrides it.
