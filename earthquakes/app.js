/*
  Seismic Activity -- global earthquakes from the USGS event catalog.

  The one dashboard here that needs no credential at all: the FDSN endpoint is
  open. Deployed inside a sandboxed frame it still needs earthquake.usgs.gov on
  the allowed-hosts list, because that is what makes the call reachable --
  separate from, and here without, any credential being attached to it.
*/

(function (global) {
  "use strict";

  var DB = global.DB;
  var UI = global.DBUI;
  var html = DB.html;

  var API = "https://earthquake.usgs.gov/fdsnws/event/1/query";

  var RANGES = [
    { id: "1", label: "24 hours", days: 1, bucketHours: 1, bucket: "hour", bucketLabel: DB.clockTime },
    { id: "7", label: "7 days", days: 7, bucketHours: 6, bucket: "6 hours", bucketLabel: DB.shortDate },
    { id: "30", label: "30 days", days: 30, bucketHours: 24, bucket: "day", bucketLabel: DB.shortDate }
  ];

  /**
   * Seismic energy, in the unit its own magnitude deserves.
   *
   * A day of global activity lands somewhere around 10^14 J, so the generic
   * compact formatter renders it as "364.0T J" -- correct, and not how anybody
   * writes joules. Stepping the SI prefix into the unit gives "364 TJ".
   */
  function energy(joules) {
    if (joules == null || !isFinite(joules)) return "--";

    var steps = [
      [1e18, "EJ"],
      [1e15, "PJ"],
      [1e12, "TJ"],
      [1e9, "GJ"],
      [1e6, "MJ"]
    ];

    for (var i = 0; i < steps.length; i++) {
      if (joules >= steps[i][0]) {
        var scaled = joules / steps[i][0];
        return scaled.toFixed(scaled < 10 ? 1 : 0) + " " + steps[i][1];
      }
    }

    return DB.localeNumber(Math.round(joules)) + " J";
  }

  var MAGNITUDES = [
    { id: "1", label: "All recorded", value: 1 },
    { id: "2.5", label: "2.5+ felt", value: 2.5 },
    { id: "4.5", label: "4.5+ notable", value: 4.5 },
    { id: "6", label: "6+ major", value: 6 }
  ];

  function rangeById(id) {
    return RANGES.filter(function (range) { return range.id === id; })[0] || RANGES[0];
  }

  function magnitudeById(id) {
    return MAGNITUDES.filter(function (entry) { return entry.id === id; })[0] || MAGNITUDES[1];
  }

  /**
   * The colour a magnitude is drawn in.
   *
   * Status hues, not series slots: a magnitude band is a state, and it ships
   * with the number beside it in every place it is used, so the colour is never
   * the only thing saying "this one is serious".
   */
  function magnitudeColor(magnitude) {
    if (magnitude >= 6) return "var(--critical)";
    if (magnitude >= 4.5) return "var(--serious)";
    if (magnitude >= 2.5) return "var(--warning)";
    return "var(--series-1)";
  }

  function magnitudeBand(magnitude) {
    if (magnitude >= 6) return "Major";
    if (magnitude >= 4.5) return "Notable";
    if (magnitude >= 2.5) return "Felt";
    return "Minor";
  }

  /*
    Marker radius from magnitude, linear.

    Magnitude is already logarithmic, so a linear radius means the drawn circle
    grows with the energy's exponent rather than with the energy itself -- which
    is the readable choice. Scaling area by released energy would make an M7 a
    circle roughly a thousand times the area of an M5, and every other event on
    the map would vanish beside it.
  */
  function markerRadius(magnitude) {
    return DB.clamp(3.2 + Math.max(0, magnitude - 1) * 1.35, 4, 16);
  }

  /* Drawn as circles, so the map legend has to carry the size scale too. */
  function MapScale() {
    var sizes = [3, 5, 7];

    return html`
      <div class="map-scale">
        <div class="sizes">
          ${sizes.map(function (magnitude) {
            var r = markerRadius(magnitude);
            return html`<div class="size" key=${magnitude}>
              <svg width=${r * 2 + 3} height=${r * 2 + 3} aria-hidden="true">
                <circle
                  cx=${r + 1.5}
                  cy=${r + 1.5}
                  r=${r}
                  fill=${magnitudeColor(magnitude)}
                  fill-opacity="0.85"
                  stroke="var(--surface)"
                  stroke-width="1.5"
                />
              </svg>
              <span>M ${magnitude}</span>
            </div>`;
          })}
        </div>
        <ul class="legend" style="margin:0">
          ${[1, 2.5, 4.5, 6].map(function (floor) {
            return html`<li key=${floor}>
              <span class="swatch" style=${"background:" + magnitudeColor(floor)}></span>
              ${magnitudeBand(floor)}
            </li>`;
          })}
        </ul>
      </div>
    `;
  }

  function load(rangeId, magnitudeId, signal) {
    var range = rangeById(rangeId);
    var start = new Date(Date.now() - range.days * 86400000);

    var url =
      API +
      DB.query({
        format: "geojson",
        starttime: start.toISOString(),
        minmagnitude: magnitudeById(magnitudeId).value,
        orderby: "time",
        // Well inside the endpoint's 20,000 cap, and more than any of these
        // views can usefully draw.
        limit: 2000
      });

    return DB.fetchJson(url, { signal: signal }).then(function (payload) {
      return (payload.features || [])
        .map(function (feature) {
          var properties = feature.properties || {};
          var coordinates = (feature.geometry && feature.geometry.coordinates) || [];

          return {
            id: feature.id,
            magnitude: properties.mag,
            place: properties.place || "Unknown location",
            time: properties.time,
            depth: coordinates[2],
            longitude: coordinates[0],
            latitude: coordinates[1],
            significance: properties.sig,
            tsunami: properties.tsunami === 1,
            url: properties.url
          };
        })
        .filter(function (quake) {
          return quake.magnitude != null && isFinite(quake.magnitude) && quake.time;
        });
    });
  }

  /** Events per time bucket, with empty buckets kept so gaps stay visible. */
  function bucketByTime(quakes, range) {
    var size = range.bucketHours * 3600000;
    var now = Date.now();
    var start = now - range.days * 86400000;
    var first = Math.floor(start / size) * size;
    var counts = {};

    quakes.forEach(function (quake) {
      var key = Math.floor(quake.time / size) * size;
      counts[key] = (counts[key] || 0) + 1;
    });

    var buckets = [];

    for (var edge = first; edge <= now; edge += size) {
      buckets.push({ label: range.bucketLabel(edge), value: counts[edge] || 0, at: edge });
    }

    return buckets;
  }

  /** Half-step magnitude bins, which is how seismic catalogues are read. */
  function bucketByMagnitude(quakes) {
    var bins = {};

    quakes.forEach(function (quake) {
      var floor = Math.floor(quake.magnitude * 2) / 2;
      bins[floor] = (bins[floor] || 0) + 1;
    });

    return Object.keys(bins)
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .map(function (floor) {
        return {
          label: floor.toFixed(1),
          value: bins[floor],
          color: magnitudeColor(floor),
          note: { label: "Band", value: magnitudeBand(floor) }
        };
      });
  }

  function App() {
    var rangeStore = DB.useStored("quakes:range", "1");
    var rangeId = rangeStore[0];
    var setRangeId = rangeStore[1];

    var magnitudeStore = DB.useStored("quakes:magnitude", "2.5");
    var magnitudeId = magnitudeStore[0];
    var setMagnitudeId = magnitudeStore[1];

    var request = DB.useAsync(
      function (signal) { return load(rangeId, magnitudeId, signal); },
      [rangeId, magnitudeId]
    );

    DB.useInterval(request.reload, 300);

    var quakes = request.data || [];
    var range = rangeById(rangeId);

    var summary = DB.useMemo(
      function () {
        if (!quakes.length) return null;

        var magnitudes = quakes.map(function (quake) { return quake.magnitude; });
        var depths = quakes
          .map(function (quake) { return quake.depth; })
          .filter(function (depth) { return depth != null && isFinite(depth); });

        var strongest = quakes.reduce(function (best, quake) {
          return quake.magnitude > best.magnitude ? quake : best;
        }, quakes[0]);

        return {
          count: quakes.length,
          strongest: strongest,
          meanDepth: DB.mean(depths),
          major: quakes.filter(function (quake) { return quake.magnitude >= 6; }).length,
          released: DB.sum(
            magnitudes.map(function (magnitude) {
              // Gutenberg-Richter: energy in joules from moment magnitude.
              return Math.pow(10, 1.5 * magnitude + 4.8);
            })
          )
        };
      },
      [quakes]
    );

    var timeSeries = DB.useMemo(
      function () { return bucketByTime(quakes, range); },
      [quakes, range]
    );

    var magnitudeBins = DB.useMemo(function () { return bucketByMagnitude(quakes); }, [quakes]);

    var scatterPoints = DB.useMemo(
      function () {
        return quakes
          .filter(function (quake) { return quake.depth != null && isFinite(quake.depth); })
          .slice(0, 600)
          .map(function (quake) {
            return {
              x: quake.magnitude,
              y: quake.depth,
              r: 4.5,
              color: magnitudeColor(quake.magnitude),
              title: quake.place,
              rows: [
                { label: "Magnitude", value: quake.magnitude.toFixed(1) },
                { label: "Depth", value: quake.depth.toFixed(1) + " km" },
                { label: "When", value: DB.relative(quake.time) }
              ]
            };
          });
      },
      [quakes]
    );

    /*
      Weakest first, so the strongest circles are painted last and sit on top.
      Along a subduction zone the marks overlap heavily, and in catalogue order
      an M6 can end up hidden under a dozen aftershocks an eighth its size.
    */
    var mapPoints = DB.useMemo(
      function () {
        return quakes
          .filter(function (quake) {
            return quake.longitude != null && quake.latitude != null;
          })
          .slice()
          .sort(function (a, b) { return a.magnitude - b.magnitude; })
          .map(function (quake) {
            return {
              lon: quake.longitude,
              lat: quake.latitude,
              radius: markerRadius(quake.magnitude),
              color: magnitudeColor(quake.magnitude),
              href: quake.url,
              title: quake.place,
              rows: [
                { label: "Magnitude", value: quake.magnitude.toFixed(1) },
                { label: "Depth", value: quake.depth == null ? "--" : quake.depth.toFixed(1) + " km" },
                { label: "When", value: DB.relative(quake.time) }
              ]
            };
          });
      },
      [quakes]
    );

    var columns = [
      {
        key: "magnitude",
        label: "Mag",
        num: true,
        render: function (row) {
          return html`<span class="badge">
            <span class="dot" style=${"background:" + magnitudeColor(row.magnitude)}></span>
            ${row.magnitude.toFixed(1)}
          </span>`;
        }
      },
      {
        key: "place",
        label: "Location",
        render: function (row) {
          return row.url
            ? html`<a href=${row.url} target="_blank" rel="noopener noreferrer">${row.place}</a>`
            : row.place;
        }
      },
      {
        key: "depth",
        label: "Depth",
        num: true,
        render: function (row) {
          return row.depth == null ? "--" : row.depth.toFixed(1) + " km";
        }
      },
      {
        key: "significance",
        label: "Significance",
        num: true,
        render: function (row) { return row.significance == null ? "--" : row.significance; }
      },
      {
        key: "time",
        label: "When",
        num: true,
        render: function (row) {
          return html`<span title=${DB.dateTime(row.time)}>${DB.relative(row.time)}</span>`;
        }
      }
    ];

    var blocking = request.error && !quakes.length;

    return html`
      <div class="shell">
        <${UI.Topbar}
          title="Seismic Activity"
          subtitle="Global earthquake catalog, USGS"
          updatedAt=${request.updatedAt}
          loading=${request.loading}
          onReload=${request.reload}
        />

        <div class="filters">
          <div class="field">
            <span class="sr-only" id="range-label">Time range</span>
            <div class="segmented" role="group" aria-labelledby="range-label">
              ${RANGES.map(function (option) {
                return html`<button
                  key=${option.id}
                  type="button"
                  aria-pressed=${String(option.id === rangeId)}
                  onClick=${function () { setRangeId(option.id); }}
                >
                  ${option.label}
                </button>`;
              })}
            </div>
          </div>

          <div class="field">
            <label for="magnitude">Magnitude</label>
            <select
              id="magnitude"
              value=${magnitudeId}
              onChange=${function (event) { setMagnitudeId(event.target.value); }}
            >
              ${MAGNITUDES.map(function (option) {
                return html`<option key=${option.id} value=${option.id}>${option.label}</option>`;
              })}
            </select>
          </div>

          ${request.error && quakes.length
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
                  label="Events recorded"
                  value=${summary ? DB.localeNumber(summary.count) : "--"}
                  foot=${"Magnitude " + magnitudeById(magnitudeId).value + "+, last " + range.label}
                />
                <${UI.StatTile}
                  label="Strongest"
                  value=${summary ? "M " + summary.strongest.magnitude.toFixed(1) : "--"}
                  foot=${summary ? summary.strongest.place : ""}
                />
                <${UI.StatTile}
                  label="Mean depth"
                  value=${summary && summary.meanDepth != null
                    ? summary.meanDepth.toFixed(0) + " km"
                    : "--"}
                  foot="Shallower quakes shake harder"
                />
                <${UI.StatTile}
                  label="Energy released"
                  value=${summary ? energy(summary.released) : "--"}
                  foot=${summary ? summary.major + " at magnitude 6 or above" : ""}
                />

                <${UI.Card}
                  span="12"
                  title="Where they struck"
                  sub="Drag to pan and scroll to zoom once you are in. Circle size is magnitude; click one to open its USGS event page."
                >
                  ${request.loading && !quakes.length
                    ? html`<${UI.Loading} height=${300} />`
                    : html`<${UI.GeoMap}
                        points=${mapPoints}
                        maxHeight=${440}
                        label=${"World map of " + mapPoints.length + " earthquakes in the selected range"}
                        footer=${html`<${MapScale} />`}
                      />`}
                <//>

                <${UI.Card}
                  span="8"
                  title=${"Events per " + range.bucket}
                  sub="Counts are raw detections, so a swarm reads as a spike."
                >
                  ${request.loading && !quakes.length
                    ? html`<${UI.Loading} height=${180} />`
                    : html`<${UI.BarChart}
                        data=${timeSeries}
                        height=${200}
                        valueLabel="Events"
                        formatValue=${function (value) { return DB.localeNumber(Math.round(value)); }}
                        label="Earthquake count over time"
                      />`}
                <//>

                <${UI.Card}
                  span="4"
                  title="Magnitude distribution"
                  sub="Half-step bins. Each band is labelled, not colour-coded alone."
                >
                  ${request.loading && !quakes.length
                    ? html`<${UI.Loading} height=${180} />`
                    : html`<${UI.BarChart}
                        data=${magnitudeBins}
                        height=${200}
                        valueLabel="Events"
                        formatValue=${function (value) { return DB.localeNumber(Math.round(value)); }}
                        label="Distribution of earthquake magnitudes"
                      />`}
                <//>

                <${UI.Card}
                  span="6"
                  title="Depth against magnitude"
                  sub="Deep events are common; deep and strong is the rarer corner."
                >
                  ${request.loading && !quakes.length
                    ? html`<${UI.Loading} height=${200} />`
                    : html`<${UI.ScatterChart}
                        points=${scatterPoints}
                        height=${240}
                        formatX=${function (value) { return "M " + value.toFixed(1); }}
                        formatY=${function (value) { return value.toFixed(0) + " km"; }}
                        label="Earthquake depth plotted against magnitude"
                      />`}
                <//>

                <${UI.Card}
                  span="6"
                  title="Strongest in range"
                  sub="Ranked by magnitude."
                >
                  ${request.loading && !quakes.length
                    ? html`<${UI.Loading} height=${200} />`
                    : html`<${UI.RankedBars}
                        data=${quakes
                          .slice()
                          .sort(function (a, b) { return b.magnitude - a.magnitude; })
                          .slice(0, 8)
                          .map(function (quake) {
                            var place = quake.place.length > 22
                              ? quake.place.slice(0, 21) + "…"
                              : quake.place;
                            return {
                              label: place,
                              value: quake.magnitude,
                              color: magnitudeColor(quake.magnitude)
                            };
                          })}
                        labelWidth=${140}
                        formatValue=${function (value) { return value.toFixed(1); }}
                        label="Strongest earthquakes in the selected range"
                      />`}
                <//>

                <${UI.Card}
                  span="12"
                  title="Event log"
                  sub="Every column sorts. Click a location to open the USGS event page."
                >
                  ${request.loading && !quakes.length
                    ? html`<${UI.Loading} height=${220} />`
                    : html`<${UI.DataTable}
                        columns=${columns}
                        rows=${quakes}
                        initialSort="time"
                        initialDir="desc"
                        limit=${60}
                        rowKey=${function (row) { return row.id; }}
                      />`}
                <//>
              </div>
            `}
      </div>
    `;
  }

  DB.render(html`<${App} />`, document.getElementById("root"));
})(window);
