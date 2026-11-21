/*
  Data Center Construction -- sites OpenStreetMap maps as data centers being
  built, read live from the Overpass API.

  Keyless, like the seismic dashboard. Deployed inside a sandboxed frame it
  still needs overpass-api.de on the allowed-hosts list.

  Two things shape this file more than anything else:

  - The scan is global and slow. Overpass has no worldwide tag index, so
    finding a rare tag anywhere on Earth means walking the whole planet, and a
    query takes the better part of a minute. The last good result is kept in
    localStorage and shown immediately on the next visit while a fresh one is
    fetched behind it, and there is no refresh timer -- the map changes on the
    scale of days, and the public instance asks clients not to poll.

  - Coverage is whatever mappers have tagged. This is a census of what is on
    the map, not of what is being built, and the page says so rather than
    presenting a count of tagged sites as an industry figure.
*/

(function (global) {
  "use strict";

  var DB = global.DB;
  var UI = global.DBUI;
  var html = DB.html;

  var API = "https://overpass-api.de/api/interpreter";
  var CACHE_KEY = "dc:cache";

  /*
    Both spellings appear in the data, and the purpose is carried by three
    different keys depending on which tagging scheme the mapper followed:
    `construction=*` beside landuse/building=construction, the lifecycle
    prefix `construction:telecom=*`, and `construction:building=*`.
  */
  var QUERY =
    "[out:json][timeout:120];(" +
    'nwr["construction"~"^data_cent(er|re)$"];' +
    'nwr["construction:telecom"~"^data_cent(er|re)$"];' +
    'nwr["construction:building"~"^data_cent(er|re)$"];' +
    ");out tags bb qt;";

  /*
    The stage a site is at, read from how it is drawn. A mapper who draws
    `building=construction` is outlining a structure going up; one who draws
    `landuse=construction` is outlining cleared, graded ground. Neither tag is
    a timeline, but the difference is real on the ground.
  */
  var STAGES = [
    { id: "building", label: "Structure rising", color: "var(--series-1)" },
    { id: "site", label: "Site works", color: "var(--series-2)" },
    { id: "tagged", label: "Tagged only", color: "var(--series-3)" },
    { id: "stalled", label: "Stalled", color: "var(--ink-muted)" }
  ];

  function stageById(id) {
    return STAGES.filter(function (stage) { return stage.id === id; })[0] || STAGES[2];
  }

  function stageOf(tags) {
    if (tags.abandoned === "yes" || tags.disused === "yes" || tags.landuse === "brownfield") {
      return "stalled";
    }
    if (tags.building === "construction") return "building";
    if (tags.landuse === "construction") return "site";
    return "tagged";
  }

  /*
    Region from coordinates, deliberately coarse.

    Almost no site carries addr:country, and resolving each point against
    country boundaries would mean a second Overpass query per site. Longitude
    and latitude boxes get continents right for every site actually in the data
    and are labelled as approximate everywhere they are shown.
  */
  var REGIONS = ["North America", "Latin America", "Europe", "Middle East & Africa", "Asia", "Oceania"];

  function regionOf(lat, lon) {
    if (lon < -30) return lat > 15 ? "North America" : "Latin America";
    if (lon < 45 && lat >= 35) return "Europe";
    if (lon < 60 && lat < 35) return "Middle East & Africa";
    if (lon >= 110 && lat < -10) return "Oceania";
    return "Asia";
  }

  /** "96 MW", "1.2 GW", "40" -> megawatts, or null. */
  function parsePower(raw) {
    if (!raw) return null;
    var match = String(raw).replace(",", ".").match(/([\d.]+)\s*(gw|mw|kw)?/i);
    if (!match) return null;
    var value = parseFloat(match[1]);
    if (!isFinite(value)) return null;
    var unit = (match[2] || "mw").toLowerCase();
    if (unit === "gw") return value * 1000;
    if (unit === "kw") return value / 1000;
    return value;
  }

  /*
    Hectares covered by the element's bounding box.

    An overestimate for anything not drawn square to the meridians, which is
    why it is called "extent" on the page and never "area". It is used to rank
    and size sites against each other, where a consistent overestimate is fine.
  */
  function extentHectares(bounds) {
    if (!bounds) return null;
    var midLat = ((bounds.minlat + bounds.maxlat) / 2) * (Math.PI / 180);
    var height = (bounds.maxlat - bounds.minlat) * 111320;
    var width = (bounds.maxlon - bounds.minlon) * 111320 * Math.cos(midLat);
    var hectares = (height * width) / 10000;
    return hectares > 0 ? hectares : null;
  }

  function openingYear(raw) {
    var match = raw && String(raw).match(/^(\d{4})/);
    return match ? Number(match[1]) : null;
  }

  function hectares(value) {
    if (value == null) return "--";
    return value < 10 ? value.toFixed(1) + " ha" : DB.localeNumber(Math.round(value)) + " ha";
  }

  function megawatts(value) {
    if (value == null) return "--";
    return value >= 1000 ? (value / 1000).toFixed(1) + " GW" : DB.localeNumber(Math.round(value)) + " MW";
  }

  function truncate(text, length) {
    return text.length > length ? text.slice(0, length - 1) + "…" : text;
  }

  function toSite(element) {
    var tags = element.tags || {};
    var bounds = element.bounds;
    var lat = element.lat != null ? element.lat : bounds && (bounds.minlat + bounds.maxlat) / 2;
    var lon = element.lon != null ? element.lon : bounds && (bounds.minlon + bounds.maxlon) / 2;
    if (lat == null || lon == null) return null;

    var operator = tags.operator || tags["operator:short"] || "";

    return {
      id: element.type + "/" + element.id,
      name: tags.name || tags.alt_name || (operator ? operator + " site" : "Unnamed site"),
      named: !!tags.name,
      operator: operator,
      stage: stageOf(tags),
      region: regionOf(lat, lon),
      lat: lat,
      lon: lon,
      extent: extentHectares(bounds),
      power: parsePower(tags.it_power || tags["construction:data_center:power"] || tags["data_center:power"]),
      opening: tags.opening_date || "",
      openingYear: openingYear(tags.opening_date),
      checked: tags.check_date || tags["survey:date"] || "",
      city: tags["addr:city"] || "",
      url: "https://www.openstreetmap.org/" + element.type + "/" + element.id
    };
  }

  function parse(payload) {
    return (payload.elements || []).map(toSite).filter(Boolean);
  }

  function readCache() {
    try {
      var cached = JSON.parse(DB.readStore(CACHE_KEY) || "null");
      if (!cached || !cached.elements) return null;
      return { sites: parse(cached), at: new Date(cached.at) };
    } catch (error) {
      return null;
    }
  }

  /*
    The public instance sheds load far more often than a typical API: when its
    query workers are full it answers 502 (or 429 per client) at once, with a
    body asking clients to retry with exponential backoff. So that is what
    happens here -- 5, 10, 20 and 40 seconds -- before the error card appears.
  */
  var BACKOFF = [5, 10, 20, 40];

  function wait(seconds, signal) {
    return new Promise(function (resolve, reject) {
      var id = global.setTimeout(resolve, seconds * 1000);
      if (signal) {
        signal.addEventListener("abort", function () {
          global.clearTimeout(id);
          reject(signal.reason || new DOMException("Aborted", "AbortError"));
        });
      }
    });
  }

  function fetchWithBackoff(url, signal, attempt) {
    attempt = attempt || 0;

    return DB.fetchJson(url, { signal: signal }).catch(function (error) {
      var status = error && error.status;
      var busy = status === 429 || status >= 500;

      if (!busy || (signal && signal.aborted)) throw error;

      if (attempt >= BACKOFF.length) {
        error.message =
          "Overpass is at capacity (HTTP " + status + ") and stayed that way through " +
          (attempt + 1) + " attempts over about a minute and a half. This usually clears " +
          "within a few minutes.";
        throw error;
      }

      return wait(BACKOFF[attempt], signal).then(function () {
        return fetchWithBackoff(url, signal, attempt + 1);
      });
    });
  }

  function load(signal) {
    return fetchWithBackoff(API + DB.query({ data: QUERY }), signal).then(function (payload) {
      // Only the fields toSite reads, so the cache stays a few tens of KB.
      DB.writeStore(
        CACHE_KEY,
        JSON.stringify({
          at: Date.now(),
          elements: (payload.elements || []).map(function (element) {
            return {
              type: element.type,
              id: element.id,
              lat: element.lat,
              lon: element.lon,
              bounds: element.bounds,
              tags: element.tags
            };
          })
        })
      );
      return parse(payload);
    });
  }

  /*
    Marker radius from site extent, by square root so circle area tracks
    ground area. A node has no extent and gets the floor size, which is the
    honest reading: we do not know how big it is.
  */
  function markerRadius(extent) {
    if (extent == null) return 4;
    return DB.clamp(3 + Math.sqrt(extent) * 0.9, 4, 15);
  }

  function MapKey() {
    return html`
      <div class="map-scale">
        <div class="sizes">
          ${[1, 10, 50].map(function (size) {
            var r = markerRadius(size);
            return html`<div class="size" key=${size}>
              <svg width=${r * 2 + 3} height=${r * 2 + 3} aria-hidden="true">
                <circle cx=${r + 1.5} cy=${r + 1.5} r=${r} fill="var(--ink-muted)"
                  fill-opacity="0.6" stroke="var(--surface)" stroke-width="1.5" />
              </svg>
              <span>${size} ha</span>
            </div>`;
          })}
        </div>
        <ul class="legend" style="margin:0">
          ${STAGES.map(function (stage) {
            return html`<li key=${stage.id}>
              <span class="swatch" style=${"background:" + stage.color}></span>
              ${stage.label}
            </li>`;
          })}
        </ul>
      </div>
    `;
  }

  function StageBadge(props) {
    var stage = stageById(props.stage);
    return html`<span class="badge">
      <span class="dot" style=${"background:" + stage.color}></span>
      ${stage.label}
    </span>`;
  }

  function App() {
    var cache = DB.useMemo(readCache, []);

    var stageStore = DB.useStored("dc:stage", "active");
    var stageFilter = stageStore[0];
    var setStageFilter = stageStore[1];

    var regionStore = DB.useStored("dc:region", "all");
    var regionFilter = regionStore[0];
    var setRegionFilter = regionStore[1];

    var request = DB.useAsync(load, []);

    var allSites = request.data || (cache && cache.sites) || [];
    var updatedAt = request.updatedAt || (cache && cache.at);
    var waiting = request.loading && !allSites.length;

    var sites = DB.useMemo(
      function () {
        return allSites.filter(function (site) {
          if (stageFilter === "active" && site.stage === "stalled") return false;
          if (stageFilter !== "active" && stageFilter !== "all" && site.stage !== stageFilter) return false;
          if (regionFilter !== "all" && site.region !== regionFilter) return false;
          return true;
        });
      },
      [allSites, stageFilter, regionFilter]
    );

    var summary = DB.useMemo(
      function () {
        var withPower = sites.filter(function (site) { return site.power != null; });
        var withExtent = sites.filter(function (site) { return site.extent != null; });
        var operators = {};
        sites.forEach(function (site) { if (site.operator) operators[site.operator] = true; });

        var thisYear = new Date().getFullYear();
        var upcoming = sites
          .filter(function (site) { return site.openingYear != null && site.openingYear >= thisYear; })
          .sort(function (a, b) { return a.opening < b.opening ? -1 : 1; });

        return {
          count: sites.length,
          operators: Object.keys(operators).length,
          power: DB.sum(withPower.map(function (site) { return site.power; })),
          powerCount: withPower.length,
          extent: DB.sum(withExtent.map(function (site) { return site.extent; })),
          extentCount: withExtent.length,
          next: upcoming[0] || null,
          datedCount: sites.filter(function (site) { return site.openingYear != null; }).length
        };
      },
      [sites]
    );

    /* Smallest first, so the large campuses are painted last and stay on top. */
    var mapPoints = DB.useMemo(
      function () {
        return sites
          .slice()
          .sort(function (a, b) { return (a.extent || 0) - (b.extent || 0); })
          .map(function (site) {
            return {
              lon: site.lon,
              lat: site.lat,
              radius: markerRadius(site.extent),
              color: stageById(site.stage).color,
              href: site.url,
              title: site.name,
              rows: [
                { label: "Operator", value: site.operator || "Not tagged" },
                { label: "Stage", value: stageById(site.stage).label },
                { label: "Extent", value: hectares(site.extent) },
                { label: "Opening", value: site.opening || "Not tagged" }
              ]
            };
          });
      },
      [sites]
    );

    var byRegion = DB.useMemo(
      function () {
        var counts = {};
        sites.forEach(function (site) { counts[site.region] = (counts[site.region] || 0) + 1; });
        return REGIONS.filter(function (region) { return counts[region]; }).map(function (region) {
          return { label: region, value: counts[region] };
        });
      },
      [sites]
    );

    var byOperator = DB.useMemo(
      function () {
        var counts = {};
        sites.forEach(function (site) {
          if (site.operator) counts[site.operator] = (counts[site.operator] || 0) + 1;
        });
        return Object.keys(counts)
          .sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); })
          .slice(0, 10)
          .map(function (name) { return { label: truncate(name, 22), value: counts[name] }; });
      },
      [sites]
    );

    var byYear = DB.useMemo(
      function () {
        var counts = {};
        sites.forEach(function (site) {
          if (site.openingYear != null) counts[site.openingYear] = (counts[site.openingYear] || 0) + 1;
        });
        var years = Object.keys(counts).map(Number);
        if (!years.length) return [];
        var rows = [];
        // Every year between the first and last, so a gap reads as a gap.
        for (var year = Math.min.apply(null, years); year <= Math.max.apply(null, years); year++) {
          rows.push({ label: String(year), value: counts[year] || 0 });
        }
        return rows;
      },
      [sites]
    );

    var largest = DB.useMemo(
      function () {
        return sites
          .filter(function (site) { return site.extent != null; })
          .sort(function (a, b) { return b.extent - a.extent; })
          .slice(0, 8)
          .map(function (site) {
            return {
              label: truncate(site.name, 22),
              value: site.extent,
              color: stageById(site.stage).color
            };
          });
      },
      [sites]
    );

    var columns = [
      {
        key: "name",
        label: "Site",
        render: function (row) {
          return html`<a href=${row.url} target="_blank" rel="noopener noreferrer"
            style=${row.named ? "" : "font-style:italic"}>${row.name}</a>`;
        }
      },
      { key: "operator", label: "Operator", value: function (row) { return row.operator || null; }, render: function (row) { return row.operator || "--"; } },
      {
        key: "region",
        label: "Region",
        render: function (row) { return row.city ? row.city + ", " + row.region : row.region; }
      },
      {
        key: "stage",
        label: "Stage",
        value: function (row) { return STAGES.indexOf(stageById(row.stage)); },
        render: function (row) { return html`<${StageBadge} stage=${row.stage} />`; }
      },
      { key: "extent", label: "Extent", num: true, render: function (row) { return hectares(row.extent); } },
      { key: "power", label: "IT power", num: true, render: function (row) { return megawatts(row.power); } },
      { key: "opening", label: "Opening", num: true, value: function (row) { return row.opening || null; }, render: function (row) { return row.opening || "--"; } },
      { key: "checked", label: "Last checked", num: true, value: function (row) { return row.checked || null; }, render: function (row) { return row.checked || "--"; } }
    ];

    var blocking = request.error && !allSites.length;
    var stale = request.error && allSites.length;
    var fromCache = !request.data && cache && allSites.length;

    return html`
      <div class="shell">
        <${UI.Topbar}
          title="Data Center Construction"
          subtitle="Sites mapped as under construction, OpenStreetMap via Overpass"
          updatedAt=${updatedAt}
          loading=${request.loading}
          onReload=${request.reload}
        />

        <div class="filters">
          <div class="field">
            <span class="sr-only" id="stage-label">Stage</span>
            <div class="segmented" role="group" aria-labelledby="stage-label">
              ${[{ id: "active", label: "Active" }].concat(STAGES.slice(0, 3)).concat([{ id: "all", label: "All" }])
                .map(function (option) {
                  return html`<button
                    key=${option.id}
                    type="button"
                    aria-pressed=${String(option.id === stageFilter)}
                    onClick=${function () { setStageFilter(option.id); }}
                  >
                    ${option.label}
                  </button>`;
                })}
            </div>
          </div>

          <div class="field">
            <label for="region">Region</label>
            <select
              id="region"
              value=${regionFilter}
              onChange=${function (event) { setRegionFilter(event.target.value); }}
            >
              <option value="all">Everywhere</option>
              ${REGIONS.map(function (region) {
                return html`<option key=${region} value=${region}>${region}</option>`;
              })}
            </select>
          </div>

          ${request.loading && fromCache
            ? html`<span class="badge">
                <span class="dot" style="background:var(--series-1)"></span>
                Showing saved scan, fetching a fresh one (about a minute)
              </span>`
            : null}

          ${stale
            ? html`<span class="badge" title=${request.error.message}>
                <span class="dot" style="background:var(--warning)"></span>
                Showing last good data
              </span>`
            : null}
        </div>

        ${blocking
          ? html`<${UI.Card}>
              <${UI.ErrorState} message=${request.error.message} onRetry=${request.reload} />
            <//>`
          : html`
              <div class="grid">
                <${UI.StatTile}
                  label="Sites under construction"
                  value=${waiting ? "--" : DB.localeNumber(summary.count)}
                  foot=${waiting ? "Scanning the whole map, about a minute" : "Mapped in OpenStreetMap"}
                />
                <${UI.StatTile}
                  label="Operators named"
                  value=${waiting ? "--" : DB.localeNumber(summary.operators)}
                  foot=${waiting ? "" : (summary.count - sites.filter(function (s) { return s.operator; }).length) + " sites with no operator tagged"}
                />
                <${UI.StatTile}
                  label="Ground covered"
                  value=${waiting ? "--" : hectares(summary.extent)}
                  foot=${waiting ? "" : "Bounding boxes of " + summary.extentCount + " drawn sites"}
                />
                <${UI.StatTile}
                  label="Next opening"
                  value=${waiting ? "--" : summary.next ? summary.next.opening : "--"}
                  foot=${waiting ? "" : summary.next
                    ? truncate(summary.next.name, 34) + " · " + summary.datedCount + " sites dated"
                    : "No future opening dates tagged"}
                />

                <${UI.Card}
                  span="12"
                  title="Where they are being built"
                  sub="Drag to pan and scroll to zoom once you are in. Circle size is site extent; click one to open it on OpenStreetMap."
                >
                  ${waiting
                    ? html`<${UI.Loading} height=${300} />`
                    : html`<${UI.GeoMap}
                        points=${mapPoints}
                        maxHeight=${440}
                        label=${"World map of " + mapPoints.length + " data center construction sites"}
                        footer=${html`<${MapKey} />`}
                      />`}
                <//>

                <${UI.Card}
                  span="4"
                  title="By region"
                  sub="Approximate, from coordinates."
                >
                  ${waiting
                    ? html`<${UI.Loading} height=${180} />`
                    : html`<${UI.RankedBars}
                        data=${byRegion.slice().sort(function (a, b) { return b.value - a.value; })}
                        labelWidth=${140}
                        formatValue=${function (value) { return DB.localeNumber(value); }}
                        label="Construction sites by region"
                      />`}
                <//>

                <${UI.Card}
                  span="4"
                  title="Most active operators"
                  sub="Sites per operator, as tagged."
                >
                  ${waiting
                    ? html`<${UI.Loading} height=${180} />`
                    : html`<${UI.RankedBars}
                        data=${byOperator}
                        labelWidth=${150}
                        formatValue=${function (value) { return DB.localeNumber(value); }}
                        label="Construction sites per operator"
                        emptyMessage="No operators tagged in this selection."
                      />`}
                <//>

                <${UI.Card}
                  span="4"
                  title="Expected opening"
                  sub=${waiting ? "" : summary.datedCount + " of " + summary.count + " sites carry an opening date."}
                >
                  ${waiting
                    ? html`<${UI.Loading} height=${180} />`
                    : html`<${UI.BarChart}
                        data=${byYear}
                        height=${200}
                        valueLabel="Sites"
                        formatValue=${function (value) { return DB.localeNumber(Math.round(value)); }}
                        label="Construction sites by expected opening year"
                        emptyMessage="No opening dates tagged in this selection."
                      />`}
                <//>

                <${UI.Card}
                  span="12"
                  title="Largest sites"
                  sub="By bounding-box extent, which overstates any site not drawn square to north."
                >
                  ${waiting
                    ? html`<${UI.Loading} height=${200} />`
                    : html`<${UI.RankedBars}
                        data=${largest}
                        labelWidth=${170}
                        formatValue=${hectares}
                        label="Largest data center construction sites by extent"
                        emptyMessage="No drawn outlines in this selection."
                      />`}
                <//>

                <${UI.Card}
                  span="12"
                  title="Site register"
                  sub=${"Every column sorts. Italic names are unnamed on the map. " +
                    (waiting ? "" : summary.powerCount + " sites tag their IT power, " + megawatts(summary.power) + " between them.")}
                >
                  ${waiting
                    ? html`<${UI.Loading} height=${220} />`
                    : html`<${UI.DataTable}
                        columns=${columns}
                        rows=${sites}
                        initialSort="extent"
                        initialDir="desc"
                        limit=${200}
                        rowKey=${function (row) { return row.id; }}
                      />`}
                <//>

                <p style="grid-column:1 / -1;margin:0;color:var(--ink-muted);font-size:12px">
                  Coverage is whatever OpenStreetMap contributors have tagged — a census of the map, not
                  of the industry. Map data © OpenStreetMap contributors, ODbL.
                </p>
              </div>
            `}
      </div>
    `;
  }

  DB.render(html`<${App} />`, document.getElementById("root"));
})(window);
