/*
  Market Watch -- equity quotes and market news, from Finnhub.

  Finnhub takes its credential as a `token` query parameter, so the deployment
  setup matches the weather dashboard: FINNHUB_API_KEY as a SECRET variable, and
  a query-located credential named `token` on the finnhub.io target. With no key
  in hand `DB.query` omits the parameter entirely and the proxy attaches it.

  Only endpoints on the free tier are used. Candle history is not among them, so
  there is no intraday price line here -- the day's structure is read from the
  open/high/low/previous-close figures the quote endpoint does return, rather
  than by drawing a chart the free tier cannot fill.
*/

(function (global) {
  "use strict";

  var DB = global.DB;
  var UI = global.DBUI;
  var html = DB.html;

  var API = "https://finnhub.io/api/v1";
  var STORE_KEY = "stocks:key";

  /* Substituted only if FINNHUB_API_KEY is registered as a public variable.
     Left as written when it is a secret -- see the header comment. */
  var ENV_KEY = "%FINNHUB_API_KEY%";

  var DEFAULT_SYMBOLS = "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM";

  function parseSymbols(raw) {
    return (raw || "")
      .split(/[,\s]+/)
      .map(function (symbol) { return symbol.trim().toUpperCase(); })
      .filter(Boolean)
      // The free tier allows 60 calls a minute and each symbol costs two.
      .slice(0, 12);
  }

  function load(symbols, key, signal) {
    var quotes = symbols.map(function (symbol) {
      var quote = DB.fetchJson(
        API + "/quote" + DB.query({ symbol: symbol, token: key }),
        { signal: signal }
      );

      var profile = DB.fetchJson(
        API + "/stock/profile2" + DB.query({ symbol: symbol, token: key }),
        { signal: signal }
      ).catch(function () {
        // A missing profile costs a name and a logo, not the row.
        return {};
      });

      return Promise.all([quote, profile]).then(function (results) {
        var q = results[0] || {};
        var profileData = results[1] || {};

        return {
          symbol: symbol,
          name: profileData.name || symbol,
          logo: profileData.logo || "",
          industry: profileData.finnhubIndustry || "",
          exchange: profileData.exchange || "",
          website: profileData.weburl || "",
          // Finnhub reports market capitalisation in millions.
          marketCap: profileData.marketCapitalization
            ? profileData.marketCapitalization * 1e6
            : null,
          price: q.c,
          change: q.d,
          changePercent: q.dp,
          open: q.o,
          high: q.h,
          low: q.l,
          previousClose: q.pc
        };
      });
    });

    var news = DB.fetchJson(
      API + "/news" + DB.query({ category: "general", token: key }),
      { signal: signal }
    ).catch(function () {
      return [];
    });

    return Promise.all([Promise.all(quotes), news]).then(function (results) {
      return {
        rows: results[0].filter(function (row) {
          // A symbol Finnhub does not know comes back as an all-zero quote.
          return row.price != null && row.price !== 0;
        }),
        news: (results[1] || []).slice(0, 8)
      };
    });
  }

  /**
   * Where the last trade sits between the day's low and high, 0 to 100.
   *
   * A stock up 1% and pinned to its high is a different day from one up 1% and
   * sliding back off it, and the percentage change alone cannot tell them
   * apart. Null when the day has had no range at all, which would otherwise
   * divide by zero and report a spurious 50.
   */
  function rangePosition(row) {
    if (row.high == null || row.low == null || row.price == null) return null;

    var span = row.high - row.low;
    if (span <= 0) return null;

    return DB.clamp(((row.price - row.low) / span) * 100, 0, 100);
  }

  /** The low-to-high bar drawn in each table row, with the last trade marked. */
  function RangeBar(props) {
    var position = rangePosition(props.row);
    var width = 88;
    var height = 16;

    if (position == null) return html`<span class="muted">--</span>`;

    var x = 2 + (position / 100) * (width - 4);
    var up = (props.row.changePercent || 0) >= 0;

    return html`
      <svg
        width=${width}
        height=${height}
        viewBox=${"0 0 " + width + " " + height}
        role="img"
        aria-label=${"Trading at " + Math.round(position) + " percent of today's range"}
      >
        <rect x="2" y=${height / 2 - 2} width=${width - 4} height="4" rx="2"
          fill="var(--grid)" />
        <circle cx=${x} cy=${height / 2} r="4"
          fill=${up ? "var(--pos)" : "var(--neg)"}
          stroke="var(--surface)" stroke-width="2" />
      </svg>
    `;
  }

  function App() {
    var symbolStore = DB.useStored("stocks:symbols", DEFAULT_SYMBOLS);
    var symbolText = symbolStore[0];
    var setSymbolText = symbolStore[1];

    var draftState = DB.useState(symbolText);
    var draft = draftState[0];
    var setDraft = draftState[1];

    var keyStore = DB.useStored(STORE_KEY, "");
    var storedKey = keyStore[0];
    var setStoredKey = keyStore[1];

    var key = DB.envValue(ENV_KEY) || storedKey;

    var symbols = DB.useMemo(function () { return parseSymbols(symbolText); }, [symbolText]);

    var request = DB.useAsync(
      function (signal) {
        if (!symbols.length) return Promise.resolve(null);
        return load(symbols, key, signal);
      },
      [symbols, key]
    );

    DB.useInterval(request.reload, 60);

    var payload = request.data || {};
    var rows = payload.rows || [];
    var news = payload.news || [];

    var summary = DB.useMemo(
      function () {
        if (!rows.length) return null;

        var ranked = rows.slice().sort(function (a, b) {
          return (b.changePercent || 0) - (a.changePercent || 0);
        });

        return {
          up: rows.filter(function (row) { return (row.changePercent || 0) > 0; }).length,
          best: ranked[0],
          worst: ranked[ranked.length - 1],
          capitalisation: DB.sum(
            rows.map(function (row) { return row.marketCap || 0; })
          )
        };
      },
      [rows]
    );

    var movers = DB.useMemo(
      function () {
        return rows
          .slice()
          .sort(function (a, b) { return (b.changePercent || 0) - (a.changePercent || 0); })
          .map(function (row) {
            return {
              label: row.symbol,
              value: row.changePercent || 0,
              // Polarity, with the signed figure printed on every bar.
              color: (row.changePercent || 0) >= 0 ? "var(--pos)" : "var(--neg)"
            };
          });
      },
      [rows]
    );

    var positions = DB.useMemo(
      function () {
        return rows
          .map(function (row) {
            var position = rangePosition(row);
            if (position == null) return null;

            return {
              x: position,
              y: row.changePercent || 0,
              r: 5,
              color: (row.changePercent || 0) >= 0 ? "var(--pos)" : "var(--neg)",
              title: row.symbol,
              rows: [
                { label: "Change", value: DB.percent(row.changePercent, 2) },
                { label: "In range", value: Math.round(position) + "%" },
                { label: "Day low", value: DB.money(row.low, "usd") },
                { label: "Day high", value: DB.money(row.high, "usd") }
              ]
            };
          })
          .filter(Boolean);
      },
      [rows]
    );

    var capitalisation = DB.useMemo(
      function () {
        return rows
          .filter(function (row) { return row.marketCap; })
          .sort(function (a, b) { return b.marketCap - a.marketCap; })
          .map(function (row) {
            return { label: row.symbol, value: row.marketCap };
          });
      },
      [rows]
    );

    var columns = [
      {
        key: "symbol",
        label: "Symbol",
        render: function (row) {
          return html`<span class="cell-name">
            ${row.logo && html`<img src=${row.logo} alt="" loading="lazy" />`}
            <strong>${row.symbol}</strong>
          </span>`;
        }
      },
      { key: "name", label: "Company" },
      {
        key: "price",
        label: "Last",
        num: true,
        render: function (row) { return DB.money(row.price, "usd"); }
      },
      {
        key: "change",
        label: "Change",
        num: true,
        render: function (row) {
          return html`<span class=${"delta " + DB.signClass(row.change)}>
            ${(row.change > 0 ? "+" : "") + DB.localeNumber(row.change, { maximumFractionDigits: 2 })}
          </span>`;
        }
      },
      {
        key: "changePercent",
        label: "%",
        num: true,
        render: function (row) {
          return html`<span class=${"delta " + DB.signClass(row.changePercent)}>
            ${DB.percent(row.changePercent, 2)}
          </span>`;
        }
      },
      {
        key: "range",
        label: "Day range",
        sortable: false,
        render: function (row) { return html`<${RangeBar} row=${row} />`; }
      },
      {
        key: "low",
        label: "Low",
        num: true,
        render: function (row) { return DB.money(row.low, "usd"); }
      },
      {
        key: "high",
        label: "High",
        num: true,
        render: function (row) { return DB.money(row.high, "usd"); }
      },
      {
        key: "marketCap",
        label: "Market cap",
        num: true,
        render: function (row) { return DB.moneyCompact(row.marketCap, "usd"); }
      },
      {
        key: "industry",
        label: "Industry",
        render: function (row) {
          return html`<span class="muted">${row.industry || "--"}</span>`;
        }
      }
    ];

    /*
      Asked for only after a call has failed and none has ever succeeded -- see
      the fuller note in the weather dashboard. Finnhub is the reason the rule
      is not written against a 401: it refuses an unauthenticated request
      without CORS headers, so the failure reaches script as an opaque network
      error carrying no status at all.

      Below every hook, as in the weather dashboard: saving a key flips this and
      an early return above the memos would change the hook count between two
      renders of the same component.
    */
    var mustAsk = !key && !request.updatedAt && DB.isCredentialFailure(request.error);

    if (mustAsk) {
      return html`
        <div class="shell">
          <${UI.Topbar} title="Market Watch" subtitle="Finnhub" />
          <${UI.KeyPrompt}
            title="This dashboard needs a Finnhub key"
            host="finnhub.io"
            placeholder="Your Finnhub API key"
            onSave=${setStoredKey}
            onRetry=${request.reload}
            error=${request.error && request.error.message}
          >
            Finnhub has no anonymous tier. A free account gives you a key good
            for 60 calls a minute. Deployed behind a credential proxy you would
            instead register it as a secret with a query-located credential named
            <code>token</code>, and this card would never appear.
          <//>
        </div>
      `;
    }

    var blocking = request.error && !rows.length;

    return html`
      <div class="shell">
        <${UI.Topbar}
          title="Market Watch"
          subtitle=${symbols.length + " symbols, delayed quotes from Finnhub"}
          updatedAt=${request.updatedAt}
          loading=${request.loading}
          onReload=${request.reload}
        />

        <div class="filters">
          <form
            class="field"
            style="flex:1 1 320px"
            onSubmit=${function (event) {
              event.preventDefault();
              setSymbolText(draft);
            }}
          >
            <label for="symbols">Watchlist</label>
            <input
              id="symbols"
              type="text"
              value=${draft}
              style="flex:1 1 240px"
              placeholder="AAPL, MSFT, NVDA"
              onInput=${function (event) { setDraft(event.target.value); }}
            />
            <button type="submit">Update</button>
            ${draft !== DEFAULT_SYMBOLS &&
            html`<button
              type="button"
              onClick=${function () {
                setDraft(DEFAULT_SYMBOLS);
                setSymbolText(DEFAULT_SYMBOLS);
              }}
            >
              Reset
            </button>`}
          </form>

          ${request.error && rows.length
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
                  label="Advancing"
                  value=${summary ? summary.up + " / " + rows.length : "--"}
                  foot="Up on the day"
                />
                <${UI.StatTile}
                  label="Best performer"
                  value=${summary ? summary.best.symbol : "--"}
                  delta=${summary ? summary.best.changePercent : null}
                  foot=${summary ? DB.money(summary.best.price, "usd") : ""}
                />
                <${UI.StatTile}
                  label="Worst performer"
                  value=${summary ? summary.worst.symbol : "--"}
                  delta=${summary ? summary.worst.changePercent : null}
                  foot=${summary ? DB.money(summary.worst.price, "usd") : ""}
                />
                <${UI.StatTile}
                  label="Watchlist value"
                  value=${summary ? DB.moneyCompact(summary.capitalisation, "usd") : "--"}
                  foot="Combined market capitalisation"
                />

                <${UI.Card}
                  span="6"
                  title="Today's move"
                  sub="Ranked by percentage change, with the signed figure on every bar."
                >
                  ${request.loading && !rows.length
                    ? html`<${UI.Loading} height=${210} />`
                    : html`<${UI.RankedBars}
                        data=${movers}
                        labelWidth=${62}
                        rowHeight=${28}
                        formatValue=${function (value) { return DB.percent(value, 2); }}
                        label="Percentage change on the day by symbol"
                      />`}
                <//>

                <${UI.Card}
                  span="6"
                  title="Position in today's range"
                  sub="Left is the day's low, right is its high. Top right is strength; bottom right is a gain giving itself back."
                >
                  ${request.loading && !rows.length
                    ? html`<${UI.Loading} height=${210} />`
                    : html`<${UI.ScatterChart}
                        points=${positions}
                        height=${240}
                        formatX=${function (value) { return Math.round(value) + "%"; }}
                        formatY=${function (value) { return DB.percent(value, 1); }}
                        label="Change on the day against position within the day's trading range"
                      />`}
                <//>

                <${UI.Card}
                  span="8"
                  title="Market capitalisation"
                  sub="Across the watchlist, on a shared scale."
                >
                  ${request.loading && !rows.length
                    ? html`<${UI.Loading} height=${160} />`
                    : html`<${UI.BarChart}
                        data=${capitalisation}
                        height=${190}
                        valueLabel="Market cap"
                        formatValue=${function (value) { return DB.moneyCompact(value, "usd"); }}
                        formatAxis=${DB.moneyAxis(
                          Math.max.apply(
                            null,
                            capitalisation.map(function (row) { return row.value; }).concat([0])
                          ),
                          "usd"
                        )}
                        label="Market capitalisation across the watchlist"
                      />`}
                <//>

                <${UI.Card} span="4" title="Market news" sub="General headlines, newest first.">
                  ${!news.length
                    ? html`<${UI.EmptyState} message="No headlines came back with this request." />`
                    : html`<ul style="list-style:none;margin:0;padding:0;display:grid;gap:10px">
                        ${news.map(function (item) {
                          return html`<li key=${item.id || item.url}>
                            <a
                              href=${item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style="color:var(--ink);text-decoration:none;font-weight:550;display:block;line-height:1.35"
                            >
                              ${item.headline}
                            </a>
                            <div class="muted" style="font-size:12px;margin-top:2px">
                              ${item.source} · ${DB.relative(item.datetime * 1000)}
                            </div>
                          </li>`;
                        })}
                      </ul>`}
                <//>

                <${UI.Card}
                  span="12"
                  title="Watchlist"
                  sub="Every column sorts. The day-range dot marks where the last trade sits between low and high."
                >
                  ${request.loading && !rows.length
                    ? html`<${UI.Loading} height=${220} />`
                    : html`<${UI.DataTable}
                        columns=${columns}
                        rows=${rows}
                        initialSort="changePercent"
                        initialDir="desc"
                        limit=${20}
                        rowKey=${function (row) { return row.symbol; }}
                      />`}
                <//>
              </div>
            `}
      </div>
    `;
  }

  DB.render(html`<${App} />`, document.getElementById("root"));
})(window);
