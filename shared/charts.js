/*
  The chart and UI vocabulary every dashboard in this repo is built from.

  Hand-rolled SVG rather than a charting library, for two reasons. These pages
  are built to run inside a sandboxed frame that allows scripts from a CDN but
  narrows outbound network calls to an approved list, so anything that lazily
  fetches its own assets breaks in a way that is tedious to diagnose. And every
  mark here reads its colour from the same CSS custom properties as the page
  chrome, so light and dark are one token swap rather than two sets of chart
  options.

  Mark rules held to throughout: 2px lines, markers at least 8px across, bar
  ends rounded 4px and anchored to the baseline, a 2px surface gap between
  adjacent fills and a 2px surface ring on overlapping marks, recessive grid and
  axes, and a hover layer on everything that plots (a crosshair on continuous
  forms, per-mark on discrete ones).

  Classic script -- see the note at the top of lib.js for why.
*/

(function (global) {
  "use strict";

  var DB = global.DB;
  var html = DB.html;
  var useState = DB.useState;
  var useMemo = DB.useMemo;

  var PAD = { top: 12, right: 14, bottom: 24, left: 46 };

  /* ------------------------------------------------------------------ *
   * Geometry helpers
   * ------------------------------------------------------------------ */

  /**
   * A bar with only its data-end rounded.
   *
   * The rounding goes on the end that carries the value and never on the end
   * sitting against the baseline, so the bar still reads as measured from zero.
   * The radius is clamped to half the bar's width and to its own height, which
   * is what stops a very short bar from turning into a lozenge.
   */
  function barPath(x, y, width, height, radius, horizontal, leftEnd) {
    var r = Math.max(0, Math.min(radius, width / 2, height / 2, horizontal ? width : height));

    if (r <= 0.5) return "M" + x + "," + y + "h" + width + "v" + height + "h" + -width + "Z";

    if (horizontal && leftEnd) {
      /*
        Grows right to left, so the LEFT edge is the data end and takes the
        rounding. Same outline as the case below, traversed the other way round,
        which is why every sweep flag flips to 0.
      */
      return (
        "M" + (x + width) + "," + y +
        "h" + -(width - r) +
        "a" + r + "," + r + " 0 0 0 " + -r + "," + r +
        "v" + (height - 2 * r) +
        "a" + r + "," + r + " 0 0 0 " + r + "," + r +
        "h" + (width - r) +
        "Z"
      );
    }

    if (horizontal) {
      // Grows left to right; the right edge is the data end.
      return (
        "M" + x + "," + y +
        "h" + (width - r) +
        "a" + r + "," + r + " 0 0 1 " + r + "," + r +
        "v" + (height - 2 * r) +
        "a" + r + "," + r + " 0 0 1 " + -r + "," + r +
        "h" + -(width - r) +
        "Z"
      );
    }

    // Grows bottom to top; the top edge is the data end.
    return (
      "M" + x + "," + (y + height) +
      "v" + -(height - r) +
      "a" + r + "," + r + " 0 0 1 " + r + "," + -r +
      "h" + (width - 2 * r) +
      "a" + r + "," + r + " 0 0 1 " + r + "," + r +
      "v" + (height - r) +
      "Z"
    );
  }

  function linePath(points) {
    if (!points.length) return "";

    return points
      .map(function (point, index) {
        return (index ? "L" : "M") + point[0].toFixed(2) + "," + point[1].toFixed(2);
      })
      .join("");
  }

  /* ------------------------------------------------------------------ *
   * Chrome
   * ------------------------------------------------------------------ */

  function Card(props) {
    return html`
      <section class=${DB.classes("card", props.span && "span-" + props.span, props.class)}>
        ${(props.title || props.actions) &&
        html`<header
          style="display:flex;align-items:flex-start;gap:10px;justify-content:space-between"
        >
          <div>
            ${props.title && html`<h2>${props.title}</h2>`}
            ${props.sub && html`<p class="sub">${props.sub}</p>`}
          </div>
          ${props.actions}
        </header>`}
        ${props.children}
      </section>
    `;
  }

  /**
   * Series identity, never carried by colour alone.
   *
   * Present for two or more series without exception. Clicking one hides it,
   * and hiding never repaints the survivors -- a series keeps the slot it was
   * assigned, so a colour means the same entity before and after a filter.
   */
  function Legend(props) {
    var items = props.items || [];
    if (items.length < 2) return null;

    return html`
      <ul class="legend">
        ${items.map(function (item) {
          var active = !props.hidden || !props.hidden[item.name];

          if (!props.onToggle) {
            return html`<li key=${item.name}>
              <span class="swatch" style=${"background:" + item.color}></span>${item.name}
            </li>`;
          }

          return html`<li key=${item.name}>
            <button
              type="button"
              aria-pressed=${String(active)}
              onClick=${function () {
                props.onToggle(item.name);
              }}
            >
              <span class="swatch" style=${"background:" + item.color}></span>${item.name}
            </button>
          </li>`;
        })}
      </ul>
    `;
  }

  /**
   * Anchors near an edge instead of overflowing it.
   *
   * Centring on the mark is right in the middle of a chart and wrong at its
   * sides, where half the tooltip lands outside the card and gets clipped. A
   * long place name can be 200px wide, so clamping the centre by a fixed margin
   * cannot fix it -- the tooltip has to change which corner it hangs from.
   * Likewise a mark near the top gets its tooltip below it rather than above.
   */
  function Tooltip(props) {
    if (!props.point) return null;

    var edge = 130;
    var near = props.point.x < edge;
    var far = props.point.x > props.width - edge;

    var left = near
      ? Math.max(8, props.point.x - 14)
      : far
        ? Math.min(props.width - 8, props.point.x + 14)
        : props.point.x;

    var x = near ? "0" : far ? "-100%" : "-50%";
    var below = props.point.y < 76;
    var y = below ? "14px" : "calc(-100% - 10px)";

    return html`
      <div
        class="tooltip"
        style=${"left:" + left + "px;top:" + props.point.y +
          "px;transform:translate(" + x + "," + y + ")"}
      >
        ${props.title && html`<div class="t-title">${props.title}</div>`}
        ${(props.rows || []).map(function (row, index) {
          return html`<div class="t-row" key=${index}>
            ${row.color && html`<span class="swatch" style=${"background:" + row.color}></span>`}
            <span>${row.label}</span>
            <span class="t-val">${row.value}</span>
          </div>`;
        })}
      </div>
    `;
  }

  function StatTile(props) {
    var delta = props.delta;

    return html`
      <${Card} span=${props.span || 3} class="tile">
        <p class="label">${props.label}</p>
        <div class="value">${props.value}</div>
        <div class="foot">
          ${delta != null &&
          html`<span class=${"delta " + DB.signClass(delta)}>
            ${props.deltaText || DB.percent(delta)}
          </span>`}
          ${props.foot && html`<span>${props.foot}</span>`}
        </div>
        ${props.spark &&
        html`<div style="margin-top:8px">
          <${Sparkline} values=${props.spark} color=${props.sparkColor} />
        </div>`}
      <//>
    `;
  }

  function Loading(props) {
    return html`
      <div class="state" role="status">
        <div class="skeleton" style=${"width:100%;height:" + (props.height || 120) + "px"}></div>
        <span class="sr-only">Loading</span>
      </div>
    `;
  }

  function ErrorState(props) {
    return html`
      <div class="state error" role="alert">
        <h3>${props.title || "Could not load this data"}</h3>
        <p>${props.message}</p>
        ${props.onRetry &&
        html`<button type="button" onClick=${props.onRetry}>Try again</button>`}
      </div>
    `;
  }

  function EmptyState(props) {
    return html`
      <div class="state">
        <h3>${props.title || "Nothing to show"}</h3>
        <p>${props.message}</p>
      </div>
    `;
  }

  /* ------------------------------------------------------------------ *
   * Sparkline -- decoration inside a tile or table row
   * ------------------------------------------------------------------ */

  function Sparkline(props) {
    var values = (props.values || []).filter(function (value) {
      return value != null && isFinite(value);
    });

    var width = props.width || 120;
    var height = props.height || 30;

    if (values.length < 2) return html`<svg width=${width} height=${height}></svg>`;

    var bounds = DB.extent(values);
    var x = DB.scale([0, values.length - 1], [1, width - 1]);
    var y = DB.scale(bounds, [height - 2, 2]);
    var points = values.map(function (value, index) {
      return [x(index), y(value)];
    });

    var color = props.color || "var(--series-1)";
    var last = points[points.length - 1];

    return html`
      <svg width=${width} height=${height} viewBox=${"0 0 " + width + " " + height} aria-hidden="true">
        <path
          d=${linePath(points) + "L" + last[0] + "," + height + "L" + points[0][0] + "," + height + "Z"}
          fill=${color}
          fill-opacity="0.1"
        />
        <path d=${linePath(points)} fill="none" stroke=${color} stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" />
        <circle cx=${last[0]} cy=${last[1]} r="2.5" fill=${color}
          stroke="var(--surface)" stroke-width="2" />
      </svg>
    `;
  }

  /* ------------------------------------------------------------------ *
   * Line / area chart with a crosshair
   * ------------------------------------------------------------------ */

  /**
   * props.series: [{ name, color, points: [{ x, y }] }] -- x numeric, shared
   * across series and already sorted. One axis only; two measures of different
   * scale belong in two charts.
   */
  function LineChart(props) {
    var measured = DB.useWidth(680);
    var wrapRef = measured[0];
    var width = measured[1];
    var height = props.height || 220;

    var hoverState = useState(null);
    var hover = hoverState[0];
    var setHover = hoverState[1];

    var hiddenState = useState({});
    var hidden = hiddenState[0];
    var setHidden = hiddenState[1];

    var series = (props.series || []).filter(function (entry) {
      return entry.points && entry.points.length;
    });

    var shown = series.filter(function (entry) {
      return !hidden[entry.name];
    });

    var geometry = useMemo(
      function () {
        var xs = [];
        var ys = [];

        shown.forEach(function (entry) {
          entry.points.forEach(function (point) {
            xs.push(point.x);
            if (point.y != null && isFinite(point.y)) ys.push(point.y);
          });
        });

        if (!xs.length) return null;

        var xDomain = DB.extent(xs);
        var yBounds = DB.extent(ys);
        var yDomain = props.zeroBased ? [Math.min(0, yBounds[0]), yBounds[1]] : yBounds;
        var yTicks = DB.ticks(yDomain[0], yDomain[1], 4);

        if (yTicks.length) {
          yDomain = [Math.min(yDomain[0], yTicks[0]), Math.max(yDomain[1], yTicks[yTicks.length - 1])];
        }

        return {
          x: DB.scale(xDomain, [PAD.left, width - PAD.right]),
          y: DB.scale(yDomain, [height - PAD.bottom, PAD.top]),
          xDomain: xDomain,
          yTicks: yTicks
        };
      },
      [shown, width, height, props.zeroBased]
    );

    if (!series.length) {
      return html`<${EmptyState} message=${props.emptyMessage || "No points in this range."} />`;
    }

    var formatY = props.formatY || DB.compact;
    var formatX = props.formatX || String;
    // As in BarChart: one unit for the whole axis, taken from its largest tick.
    var formatAxis =
      props.formatY ||
      DB.compactAxis(geometry && geometry.yTicks.length ? geometry.yTicks[geometry.yTicks.length - 1] : 1);
    var plotLeft = PAD.left;
    var plotRight = width - PAD.right;

    // The x values every series shares, for snapping the crosshair.
    var axisValues = series[0].points.map(function (point) {
      return point.x;
    });

    function onMove(event) {
      if (!geometry) return;

      var box = event.currentTarget.getBoundingClientRect();
      var px = event.clientX - box.left;
      var best = 0;
      var bestDistance = Infinity;

      for (var i = 0; i < axisValues.length; i++) {
        var distance = Math.abs(geometry.x(axisValues[i]) - px);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
      }

      setHover(best);
    }

    var hoverX = geometry && hover != null ? geometry.x(axisValues[hover]) : 0;

    var rows =
      hover == null
        ? []
        : shown
            .map(function (entry) {
              var point = entry.points[hover];
              if (!point || point.y == null || !isFinite(point.y)) return null;
              return { label: entry.name, value: formatY(point.y), color: entry.color };
            })
            .filter(Boolean);

    return html`
      <div>
        <${Legend}
          items=${series}
          hidden=${hidden}
          onToggle=${function (name) {
            setHidden(function (current) {
              var next = {};
              Object.keys(current).forEach(function (key) {
                next[key] = current[key];
              });
              next[name] = !current[name];
              return next;
            });
          }}
        />
        <div class="chart-wrap" ref=${wrapRef}>
          <svg
            width=${width}
            height=${height}
            viewBox=${"0 0 " + width + " " + height}
            role="img"
            aria-label=${props.label || "Line chart"}
          >
            ${geometry &&
            geometry.yTicks.map(function (tick) {
              var y = geometry.y(tick);
              return html`<g key=${tick}>
                <line class="gridline" x1=${plotLeft} x2=${plotRight} y1=${y} y2=${y} />
                <text class="tick tick-y" x=${plotLeft - 8} y=${y + 3}>${formatAxis(tick)}</text>
              </g>`;
            })}

            <line class="baseline" x1=${plotLeft} x2=${plotRight}
              y1=${height - PAD.bottom} y2=${height - PAD.bottom} />

            ${geometry &&
            [0, 0.5, 1].map(function (fraction) {
              var value = geometry.xDomain[0] + (geometry.xDomain[1] - geometry.xDomain[0]) * fraction;
              return html`<text
                key=${fraction}
                class="tick"
                x=${geometry.x(value)}
                y=${height - PAD.bottom + 14}
                text-anchor=${fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}
              >
                ${formatX(value)}
              </text>`;
            })}

            ${geometry &&
            shown.map(function (entry) {
              var points = entry.points
                .filter(function (point) {
                  return point.y != null && isFinite(point.y);
                })
                .map(function (point) {
                  return [geometry.x(point.x), geometry.y(point.y)];
                });

              if (!points.length) return null;

              var line = linePath(points);
              var baseY = height - PAD.bottom;

              return html`<g key=${entry.name}>
                ${/*
                    Filled only while one series is on screen. Two fills both
                    dropped to the baseline overlap for their whole length, and
                    the overlap reads as a third band with a value of its own --
                    so past one series the lines carry it alone.
                  */
                props.area && shown.length === 1 &&
                html`<path
                  d=${line + "L" + points[points.length - 1][0] + "," + baseY +
                    "L" + points[0][0] + "," + baseY + "Z"}
                  fill=${entry.color}
                  fill-opacity="0.1"
                />`}
                <path d=${line} fill="none" stroke=${entry.color} stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round" />
              </g>`;
            })}

            ${geometry && hover != null &&
            html`<g>
              <line class="baseline" x1=${hoverX} x2=${hoverX} y1=${PAD.top} y2=${height - PAD.bottom} />
              ${shown.map(function (entry) {
                var point = entry.points[hover];
                if (!point || point.y == null || !isFinite(point.y)) return null;
                return html`<circle
                  key=${entry.name}
                  cx=${hoverX}
                  cy=${geometry.y(point.y)}
                  r="4"
                  fill=${entry.color}
                  stroke="var(--surface)"
                  stroke-width="2"
                />`;
              })}
            </g>`}

            <rect
              x=${plotLeft}
              y=${PAD.top}
              width=${Math.max(0, plotRight - plotLeft)}
              height=${Math.max(0, height - PAD.bottom - PAD.top)}
              fill="transparent"
              onMouseMove=${onMove}
              onMouseLeave=${function () {
                setHover(null);
              }}
            />
          </svg>

          ${hover != null && rows.length &&
          html`<${Tooltip}
            width=${width}
            point=${{ x: hoverX, y: PAD.top + 4 }}
            title=${formatX(axisValues[hover])}
            rows=${rows}
          />`}
        </div>
      </div>
    `;
  }

  /* ------------------------------------------------------------------ *
   * Bar chart -- also serves as the histogram
   * ------------------------------------------------------------------ */

  /** props.data: [{ label, value, color?, note? }] */
  function BarChart(props) {
    var measured = DB.useWidth(680);
    var wrapRef = measured[0];
    var width = measured[1];
    var height = props.height || 200;

    var hoverState = useState(null);
    var hover = hoverState[0];
    var setHover = hoverState[1];

    var data = props.data || [];

    if (!data.length) {
      return html`<${EmptyState} message=${props.emptyMessage || "No rows in this range."} />`;
    }

    var formatValue = props.formatValue || DB.compact;
    var values = data.map(function (row) {
      return row.value;
    });

    var top = Math.max.apply(null, values.concat([0]));
    var yTicks = DB.ticks(0, top || 1, 4);
    var yMax = Math.max(top, yTicks[yTicks.length - 1] || 1);
    // Ticks take their unit from the largest of them, so one axis is not asking
    // to be read as both "1.50T" and "500.0B".
    var formatAxis = props.formatAxis || props.formatValue || DB.compactAxis(yMax);

    var plotLeft = PAD.left;
    var plotRight = width - PAD.right;
    var plotBottom = height - PAD.bottom;
    var y = DB.scale([0, yMax], [plotBottom, PAD.top]);

    var band = (plotRight - plotLeft) / data.length;
    // A 2px surface gap keeps adjacent fills from reading as one shape.
    var barWidth = Math.max(1, Math.min(band - 2, props.maxBarWidth || 64));

    // Labelling every bar is noise; label enough of them to read the axis.
    var labelEvery = Math.ceil(data.length / Math.max(2, Math.floor((plotRight - plotLeft) / 64)));

    return html`
      <div class="chart-wrap" ref=${wrapRef}>
        <svg
          width=${width}
          height=${height}
          viewBox=${"0 0 " + width + " " + height}
          role="img"
          aria-label=${props.label || "Bar chart"}
        >
          ${yTicks.map(function (tick) {
            return html`<g key=${tick}>
              <line class="gridline" x1=${plotLeft} x2=${plotRight} y1=${y(tick)} y2=${y(tick)} />
              <text class="tick tick-y" x=${plotLeft - 8} y=${y(tick) + 3}>${formatAxis(tick)}</text>
            </g>`;
          })}

          <line class="baseline" x1=${plotLeft} x2=${plotRight} y1=${plotBottom} y2=${plotBottom} />

          ${data.map(function (row, index) {
            var barX = plotLeft + band * index + (band - barWidth) / 2;
            var value = isFinite(row.value) ? row.value : 0;
            var barHeight = Math.max(value > 0 ? 1 : 0, plotBottom - y(value));
            var color = row.color || props.color || "var(--series-1)";

            return html`<g
              key=${row.label + ":" + index}
              onMouseEnter=${function () {
                setHover(index);
              }}
              onMouseLeave=${function () {
                setHover(null);
              }}
            >
              <rect x=${plotLeft + band * index} y=${PAD.top} width=${band}
                height=${Math.max(0, plotBottom - PAD.top)} fill="transparent" />
              <path
                d=${barPath(barX, plotBottom - barHeight, barWidth, barHeight, 4, false)}
                fill=${color}
                fill-opacity=${hover == null || hover === index ? 1 : 0.45}
              />
            </g>`;
          })}

          ${data.map(function (row, index) {
            if (index % labelEvery !== 0) return null;
            return html`<text
              key=${"label" + index}
              class="tick"
              x=${plotLeft + band * index + band / 2}
              y=${plotBottom + 14}
              text-anchor="middle"
            >
              ${row.label}
            </text>`;
          })}
        </svg>

        ${hover != null &&
        html`<${Tooltip}
          width=${width}
          point=${{ x: plotLeft + band * hover + band / 2, y: y(Math.max(0, data[hover].value)) }}
          title=${data[hover].label}
          rows=${[
            {
              label: props.valueLabel || "Value",
              value: formatValue(data[hover].value),
              color: data[hover].color || props.color || "var(--series-1)"
            }
          ].concat(data[hover].note ? [{ label: data[hover].note.label, value: data[hover].note.value }] : [])}
        />`}
      </div>
    `;
  }

  /* ------------------------------------------------------------------ *
   * Horizontal ranked bars
   * ------------------------------------------------------------------ */

  /**
   * props.data: [{ label, value, color? }] -- already sorted by the caller.
   *
   * Any negative value switches the whole chart to a zero-centred axis, with
   * bars growing left or right from a marked zero. Drawing a -3% bar as a
   * left-anchored bar the same length as a +3% one makes the two look
   * identical, and leaves the sign carried only by the colour and the printed
   * figure -- the bar itself, which is the thing being compared, would be
   * saying something false.
   */
  function RankedBars(props) {
    var measured = DB.useWidth(680);
    var wrapRef = measured[0];
    var width = measured[1];

    var hoverState = useState(null);
    var hover = hoverState[0];
    var setHover = hoverState[1];

    var data = props.data || [];

    if (!data.length) {
      return html`<${EmptyState} message=${props.emptyMessage || "No rows in this range."} />`;
    }

    var formatValue = props.formatValue || DB.compact;
    var rowHeight = props.rowHeight || 26;
    var labelWidth = props.labelWidth || 96;
    var height = data.length * rowHeight + 6;

    var signed = data.some(function (row) {
      return row.value < 0;
    });

    var top = Math.max.apply(
      null,
      data
        .map(function (row) {
          return Math.abs(row.value) || 0;
        })
        .concat([1])
    );

    // Room for the direct value label at whichever end a bar can reach.
    var gutter = 52;
    var axisLeft = labelWidth + (signed ? gutter : 0);
    var axisRight = Math.max(axisLeft + 1, width - gutter);
    var zero = signed ? (axisLeft + axisRight) / 2 : axisLeft;
    var reach = signed ? (axisRight - axisLeft) / 2 : axisRight - axisLeft;

    return html`
      <div class="chart-wrap" ref=${wrapRef}>
        <svg
          width=${width}
          height=${height}
          viewBox=${"0 0 " + width + " " + height}
          role="img"
          aria-label=${props.label || "Ranked bar chart"}
        >
          ${signed &&
          html`<line class="baseline" x1=${zero} x2=${zero} y1="0" y2=${height} />`}

          ${data.map(function (row, index) {
            var barY = index * rowHeight + 3;
            var barHeight = rowHeight - 8;
            var value = isFinite(row.value) ? row.value : 0;
            var span = Math.max(2, (Math.abs(value) / top) * reach);
            var negative = value < 0;
            var barX = negative ? zero - span : zero;
            var color = row.color || props.color || "var(--series-1)";
            var labelX = negative ? barX - 6 : barX + span + 6;

            return html`<g
              key=${row.label + ":" + index}
              onMouseEnter=${function () {
                setHover(index);
              }}
              onMouseLeave=${function () {
                setHover(null);
              }}
            >
              <rect x="0" y=${barY - 3} width=${width} height=${rowHeight} fill="transparent" />
              <text class="tick" x=${labelWidth - 8} y=${barY + barHeight / 2 + 3} text-anchor="end">
                ${row.label}
              </text>
              <path
                d=${barPath(barX, barY, span, barHeight, 4, true, negative)}
                fill=${color}
                fill-opacity=${hover == null || hover === index ? 1 : 0.45}
              />
              <text
                class="mark-label"
                x=${labelX}
                y=${barY + barHeight / 2 + 3}
                text-anchor=${negative ? "end" : "start"}
              >
                ${formatValue(row.value)}
              </text>
            </g>`;
          })}
        </svg>
      </div>
    `;
  }

  /* ------------------------------------------------------------------ *
   * Scatter
   * ------------------------------------------------------------------ */

  /** props.points: [{ x, y, r?, color?, title, rows }] */
  function ScatterChart(props) {
    var measured = DB.useWidth(680);
    var wrapRef = measured[0];
    var width = measured[1];
    var height = props.height || 240;

    var hoverState = useState(null);
    var hover = hoverState[0];
    var setHover = hoverState[1];

    var points = props.points || [];

    if (!points.length) {
      return html`<${EmptyState} message=${props.emptyMessage || "No points in this range."} />`;
    }

    var formatX = props.formatX || DB.compact;
    var formatY = props.formatY || DB.compact;

    var xDomain = DB.extent(
      points.map(function (point) {
        return point.x;
      })
    );
    var yDomain = DB.extent(
      points.map(function (point) {
        return point.y;
      })
    );

    var plotLeft = PAD.left;
    var plotRight = width - PAD.right;
    var plotBottom = height - PAD.bottom;

    var xTicks = DB.ticks(xDomain[0], xDomain[1], 4);
    var yTicks = DB.ticks(yDomain[0], yDomain[1], 4);

    var x = DB.scale(xDomain, [plotLeft, plotRight]);
    var y = DB.scale(yDomain, [plotBottom, PAD.top]);

    return html`
      <div class="chart-wrap" ref=${wrapRef}>
        <svg
          width=${width}
          height=${height}
          viewBox=${"0 0 " + width + " " + height}
          role="img"
          aria-label=${props.label || "Scatter plot"}
        >
          ${yTicks.map(function (tick) {
            return html`<g key=${"y" + tick}>
              <line class="gridline" x1=${plotLeft} x2=${plotRight} y1=${y(tick)} y2=${y(tick)} />
              <text class="tick tick-y" x=${plotLeft - 8} y=${y(tick) + 3}>${formatY(tick)}</text>
            </g>`;
          })}

          <line class="baseline" x1=${plotLeft} x2=${plotRight} y1=${plotBottom} y2=${plotBottom} />

          ${xTicks.map(function (tick) {
            return html`<text key=${"x" + tick} class="tick" x=${x(tick)} y=${plotBottom + 14}
              text-anchor="middle">${formatX(tick)}</text>`;
          })}

          ${points.map(function (point, index) {
            return html`<circle
              key=${index}
              cx=${x(point.x)}
              cy=${y(point.y)}
              r=${point.r || 4.5}
              fill=${point.color || props.color || "var(--series-1)"}
              fill-opacity=${hover == null || hover === index ? 0.85 : 0.35}
              stroke="var(--surface)"
              stroke-width="2"
              onMouseEnter=${function () {
                setHover(index);
              }}
              onMouseLeave=${function () {
                setHover(null);
              }}
            />`;
          })}
        </svg>

        ${hover != null &&
        html`<${Tooltip}
          width=${width}
          point=${{ x: x(points[hover].x), y: y(points[hover].y) }}
          title=${points[hover].title}
          rows=${points[hover].rows || []}
        />`}
      </div>
    `;
  }

  /* ------------------------------------------------------------------ *
   * Geographic scatter
   * ------------------------------------------------------------------ */

  /*
    Equirectangular, in "world units": longitude maps to 0..360 and latitude to
    0..180, so the base map is a 2:1 box and projecting is two subtractions.

    The projection is deliberately the plainest one there is. A conformal
    projection would be wrong here for a specific reason: this map plots global
    seismicity, which lives on plate boundaries running to both poles, and
    Mercator would inflate the Aleutian and Antarctic arcs into the dominant
    features of a chart that is supposed to be about magnitude.
  */
  var MAP_W = 360;
  var MAP_H = 180;

  /*
    Natural Earth's rings are not cut at the antimeridian: Eurasia, Antarctica
    and a couple of island rings step straight from +179 to -180, which this
    projection would otherwise draw as a horizontal smear across the whole map.
    Unwrapping the longitudes keeps a ring continuous across the seam, and the
    copies at +/-360 bring the part that ran off one edge back on at the other.
    The clip on the group trims whatever falls outside the 0..360 box.
  */
  function addRing(parts, ring) {
    var xs = [];
    var ys = [];
    var offset = 0;
    var previous = ring[0];
    var i;

    // Flat [lon, lat, lon, lat, ...] -- see the note in world.js.
    for (i = 0; i < ring.length; i += 2) {
      var lon = ring[i];
      if (lon - previous > 180) offset -= 360;
      else if (previous - lon > 180) offset += 360;
      previous = lon;

      xs.push(lon + offset + 180);
      ys.push(90 - ring[i + 1]);
    }

    /* A ring that crosses the seam an odd number of times runs right around a
       pole -- Antarctica -- so it has to be closed along the pole edge rather
       than straight back to its first point. */
    var last = xs.length - 1;
    if (Math.abs(xs[last] - xs[0]) > 180) {
      var poleY = ys[0] > MAP_H / 2 ? MAP_H : 0;
      xs.push(xs[last], xs[0]);
      ys.push(poleY, poleY);
    }

    var minX = Math.min.apply(null, xs);
    var maxX = Math.max.apply(null, xs);

    for (var copy = -2; copy <= 2; copy++) {
      var dx = copy * 360;
      if (minX + dx > MAP_W || maxX + dx < 0) continue;

      parts.push("M" + (xs[0] + dx).toFixed(2) + "," + ys[0].toFixed(2));
      for (i = 1; i < xs.length; i++) {
        parts.push("L" + (xs[i] + dx).toFixed(2) + "," + ys[i].toFixed(2));
      }
      parts.push("Z");
    }
  }

  function buildLandPath(land) {
    var parts = [];

    for (var p = 0; p < land.length; p++) {
      var polygon = land[p];

      for (var r = 0; r < polygon.length; r++) {
        var ring = polygon[r];
        if (ring.length < 8) continue;
        addRing(parts, ring);
      }
    }

    return parts.join("");
  }

  var mapClipSeq = 0;

  /**
   * props.points: [{ lon, lat, radius, color, title, rows, href }]
   *
   * Pans by dragging and zooms on the wheel or the buttons. The land sits in a
   * transformed group so panning costs one attribute rather than rebuilding a
   * 5,000-point path, and the marks are projected in script so they keep their
   * size at every zoom -- a circle scaled with the map would be encoding the
   * zoom level as well as the magnitude.
   */
  function GeoMap(props) {
    var measured = DB.useWidth(680);
    var wrapRef = measured[0];
    var width = measured[1];

    var viewState = useState({ k: 1, ox: 0, oy: 0 });
    var view = viewState[0];
    var setView = viewState[1];

    var hoverState = useState(null);
    var hover = hoverState[0];
    var setHover = hoverState[1];

    var drag = DB.useRef(null);
    var svgRef = DB.useRef(null);

    var world = global.DBWorld;
    var clipId = useMemo(function () { return "map-clip-" + ++mapClipSeq; }, []);
    var landPath = useMemo(
      function () { return world ? buildLandPath(world.land) : ""; },
      [world]
    );

    var height = DB.clamp(width / 2, 220, props.maxHeight || 420);
    var baseScale = Math.min(width / MAP_W, height / MAP_H);
    var scale = baseScale * view.k;
    var mapW = MAP_W * scale;
    var mapH = MAP_H * scale;

    /* Centred while the map is smaller than its frame, and otherwise held so a
       drag cannot pull the map off the edge of its own card. */
    var ox = mapW <= width ? (width - mapW) / 2 : DB.clamp(view.ox, width - mapW, 0);
    var oy = mapH <= height ? (height - mapH) / 2 : DB.clamp(view.oy, height - mapH, 0);

    var points = props.points || [];

    var placed = useMemo(
      function () {
        return points.map(function (point) {
          return {
            point: point,
            x: ox + (point.lon + 180) * scale,
            y: oy + (90 - point.lat) * scale
          };
        });
      },
      [points, ox, oy, scale]
    );

    function zoomTo(nextK, focusX, focusY) {
      var clamped = DB.clamp(nextK, 1, 12);
      var nextScale = baseScale * clamped;

      // Hold the world point under the cursor still while the scale changes.
      var worldX = (focusX - ox) / scale;
      var worldY = (focusY - oy) / scale;

      setView({
        k: clamped,
        ox: focusX - worldX * nextScale,
        oy: focusY - worldY * nextScale
      });
    }

    function onWheel(event) {
      event.preventDefault();
      var box = event.currentTarget.getBoundingClientRect();
      var factor = Math.pow(1.0015, -event.deltaY);
      zoomTo(view.k * factor, event.clientX - box.left, event.clientY - box.top);
    }

    function onPointerDown(event) {
      if (view.k <= 1) return;
      drag.current = { x: event.clientX, y: event.clientY, ox: ox, oy: oy };
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    function onPointerMove(event) {
      if (!drag.current) return;

      setView({
        k: view.k,
        ox: drag.current.ox + (event.clientX - drag.current.x),
        oy: drag.current.oy + (event.clientY - drag.current.y)
      });
    }

    function onPointerUp(event) {
      if (!drag.current) return;
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }

    function stepZoom(factor) {
      zoomTo(view.k * factor, width / 2, height / 2);
    }

    if (!world) {
      return html`<${EmptyState}
        title="Map data did not load"
        message="shared/world.js defines the land outlines and must be loaded before this dashboard's own script."
      />`;
    }

    var graticule = [];
    for (var lon = -150; lon <= 150; lon += 30) graticule.push({ vertical: true, at: lon + 180 });
    for (var lat = -60; lat <= 60; lat += 30) graticule.push({ vertical: false, at: 90 - lat });

    return html`
      <div>
        <div class="chart-wrap map" ref=${wrapRef}>
          <svg
            ref=${svgRef}
            width=${width}
            height=${height}
            viewBox=${"0 0 " + width + " " + height}
            role="img"
            aria-label=${props.label || "Map"}
            style=${"touch-action:none;cursor:" + (view.k > 1 ? "grab" : "default")}
            onWheel=${onWheel}
            onPointerDown=${onPointerDown}
            onPointerMove=${onPointerMove}
            onPointerUp=${onPointerUp}
            onPointerCancel=${onPointerUp}
          >
            <rect x="0" y="0" width=${width} height=${height} class="map-sea" />

            <defs>
              <clipPath id=${clipId}>
                <rect x="0" y="0" width=${MAP_W} height=${MAP_H} />
              </clipPath>
            </defs>

            <g clip-path=${"url(#" + clipId + ")"}
              transform=${"translate(" + ox + "," + oy + ") scale(" + scale + ")"}>
              ${graticule.map(function (line) {
                return html`<line
                  key=${(line.vertical ? "v" : "h") + line.at}
                  class="gridline"
                  vector-effect="non-scaling-stroke"
                  x1=${line.vertical ? line.at : 0}
                  x2=${line.vertical ? line.at : MAP_W}
                  y1=${line.vertical ? 0 : line.at}
                  y2=${line.vertical ? MAP_H : line.at}
                />`;
              })}
              <path d=${landPath} class="map-land" fill-rule="evenodd"
                vector-effect="non-scaling-stroke" />
            </g>

            ${placed.map(function (entry, index) {
              var point = entry.point;
              var circle = html`<circle
                cx=${entry.x}
                cy=${entry.y}
                r=${point.radius}
                fill=${point.color}
                fill-opacity=${hover == null || hover === index ? 0.85 : 0.4}
                stroke="var(--surface)"
                stroke-width="1.5"
                onMouseEnter=${function () { setHover(index); }}
                onMouseLeave=${function () { setHover(null); }}
              />`;

              if (!point.href) return html`<g key=${index}>${circle}</g>`;

              return html`<a
                key=${index}
                href=${point.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label=${point.title}
              >
                ${circle}
              </a>`;
            })}
          </svg>

          <div class="map-controls">
            <button type="button" onClick=${function () { stepZoom(1.6); }}
              aria-label="Zoom in" title="Zoom in">+</button>
            <button type="button" onClick=${function () { stepZoom(1 / 1.6); }}
              aria-label="Zoom out" title="Zoom out" disabled=${view.k <= 1}>−</button>
            <button type="button" onClick=${function () { setView({ k: 1, ox: 0, oy: 0 }); }}
              disabled=${view.k <= 1}>Reset</button>
          </div>

          ${hover != null && placed[hover] &&
          html`<${Tooltip}
            width=${width}
            point=${{ x: placed[hover].x, y: placed[hover].y }}
            title=${placed[hover].point.title}
            rows=${placed[hover].point.rows || []}
          />`}
        </div>
        ${props.footer}
      </div>
    `;
  }

  /* ------------------------------------------------------------------ *
   * Table -- also the accessible view of every chart above
   * ------------------------------------------------------------------ */

  /**
   * props.columns: [{ key, label, num?, sortable?, value?, render? }]
   *
   * `value` supplies the sort key when the rendered cell is not the raw value;
   * `render` draws it. Sorting is local and stable enough for these sizes.
   */
  function DataTable(props) {
    var sortState = useState({ key: props.initialSort || null, dir: props.initialDir || "desc" });
    var sort = sortState[0];
    var setSort = sortState[1];

    var columns = props.columns || [];
    var rows = props.rows || [];

    var sorted = useMemo(
      function () {
        if (!sort.key) return rows;

        var column = columns.filter(function (candidate) {
          return candidate.key === sort.key;
        })[0];

        if (!column) return rows;

        var read = column.value || function (row) { return row[column.key]; };
        var direction = sort.dir === "asc" ? 1 : -1;

        return rows.slice().sort(function (a, b) {
          var left = read(a);
          var right = read(b);

          if (left == null) return 1;
          if (right == null) return -1;
          if (typeof left === "string" || typeof right === "string") {
            return String(left).localeCompare(String(right)) * direction;
          }

          return (left - right) * direction;
        });
      },
      [rows, sort, columns]
    );

    if (!rows.length) {
      return html`<${EmptyState} message=${props.emptyMessage || "Nothing matched these filters."} />`;
    }

    function toggle(key) {
      setSort(function (current) {
        if (current.key !== key) return { key: key, dir: "desc" };
        return { key: key, dir: current.dir === "desc" ? "asc" : "desc" };
      });
    }

    return html`
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              ${columns.map(function (column) {
                var active = sort.key === column.key;

                return html`<th
                  key=${column.key}
                  class=${DB.classes(column.num && "num", column.sortable !== false && "sortable")}
                  aria-sort=${active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  onClick=${column.sortable === false ? null : function () { toggle(column.key); }}
                >
                  ${column.label}
                  ${active && html`<span class="arrow">${sort.dir === "asc" ? "▲" : "▼"}</span>`}
                </th>`;
              })}
            </tr>
          </thead>
          <tbody>
            ${sorted.slice(0, props.limit || 100).map(function (row, index) {
              return html`<tr key=${props.rowKey ? props.rowKey(row) : index}>
                ${columns.map(function (column) {
                  return html`<td key=${column.key} class=${column.num ? "num" : null}>
                    ${column.render ? column.render(row, index) : row[column.key]}
                  </td>`;
                })}
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
    `;
  }

  /* ------------------------------------------------------------------ *
   * Page chrome shared by all four dashboards
   * ------------------------------------------------------------------ */

  function Topbar(props) {
    return html`
      <header class="topbar">
        <div>
          <h1>${props.title}</h1>
          <p>${props.subtitle}</p>
        </div>
        <div class="spacer"></div>
        <div class="topbar-actions">
          ${props.children}
          ${props.updatedAt &&
          html`<span class="stamp">Updated ${DB.clockTime(props.updatedAt)}</span>`}
          ${props.onReload &&
          html`<button type="button" onClick=${props.onReload} disabled=${!!props.loading}>
            ${props.loading ? "Refreshing…" : "Refresh"}
          </button>`}
          <${ThemeToggle} />
        </div>
      </header>
    `;
  }

  /*
    Drawn as SVG rather than set as a sun/moon character: the glyphs are not in
    every system UI font, and the fallback on Windows renders as an unrelated
    shape rather than as nothing, which is worse than either.
  */
  function ThemeToggle() {
    var theme = DB.useTheme();
    var dark = theme[0] === "dark";
    var label = "Switch to " + (dark ? "light" : "dark") + " mode";

    return html`
      <button
        type="button"
        onClick=${theme[1]}
        title=${label}
        aria-label=${label}
        style="display:inline-flex;align-items:center;justify-content:center;width:32px;padding:6px"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          ${dark
            ? html`<g>
                <circle cx="8" cy="8" r="3.1" />
                <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1" />
              </g>`
            : html`<path d="M13.4 9.6A6 6 0 0 1 6.4 2.6a6 6 0 1 0 7 7Z" stroke-linejoin="round" />`}
        </svg>
      </button>
    `;
  }

  /**
   * Asks for an API key, and only once a call has actually failed without one.
   * Where the credential is attached for the page by a host-side proxy, the
   * first request succeeds and this card never appears.
   *
   * It reports what the browser actually said alongside the request for a key,
   * because the two cannot always be told apart. An API that answers 401
   * without CORS headers -- Finnhub does -- reaches script as an opaque network
   * failure indistinguishable from being unable to reach the host at all, so
   * asserting "you need a key" on its own would sometimes be a confident lie.
   */
  function KeyPrompt(props) {
    var draft = useState("");
    var value = draft[0];
    var setValue = draft[1];

    return html`
      <div class="setup">
        <h2>${props.title}</h2>
        <p>${props.children}</p>
        ${props.error &&
        html`<p class="setup-error">
          <strong>The last attempt failed:</strong> ${props.error}
        </p>`}
        <form
          onSubmit=${function (event) {
            event.preventDefault();
            if (value.trim()) props.onSave(value.trim());
          }}
        >
          <input
            type="password"
            value=${value}
            placeholder=${props.placeholder || "Paste your API key"}
            autocomplete="off"
            aria-label="API key"
            onInput=${function (event) {
              setValue(event.target.value);
            }}
          />
          <button type="submit" disabled=${!value.trim()}>Save key</button>
          ${props.onRetry &&
          html`<button type="button" onClick=${props.onRetry}>Try again</button>`}
        </form>
        <p style="margin:12px 0 0;font-size:12px" class="muted">
          Stored in this browser only, never sent anywhere but ${props.host}.
        </p>
      </div>
    `;
  }

  global.DBUI = {
    Card: Card,
    Legend: Legend,
    Tooltip: Tooltip,
    StatTile: StatTile,
    Loading: Loading,
    ErrorState: ErrorState,
    EmptyState: EmptyState,
    Sparkline: Sparkline,
    LineChart: LineChart,
    BarChart: BarChart,
    RankedBars: RankedBars,
    ScatterChart: ScatterChart,
    DataTable: DataTable,
    GeoMap: GeoMap,
    Topbar: Topbar,
    ThemeToggle: ThemeToggle,
    KeyPrompt: KeyPrompt
  };
})(window);
