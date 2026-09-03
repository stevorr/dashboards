/*
  Crypto Markets -- coin prices and market structure from CoinGecko.

  The credential is optional here, which makes this the clearest illustration of
  the three places a key can come from. CoinGecko's public endpoints work with
  no key at a low rate limit; a free demo key raises it and travels in the
  `x-cg-demo-api-key` header.

  Where a host can hold that key for the page, register it as a SECRET variable
  with a header-located credential on the api.coingecko.com target. A secret is
  never substituted into the document, so the code below simply never sees one
  and never sends one -- the host-side proxy attaches it after the request
  leaves the browser. The KEY placeholder and the paste-a-key card exist for
  running this file as a plain static page.
*/

(function (global) {
  "use strict";

  var DB = global.DB;
  var UI = global.DBUI;
  var html = DB.html;

  var API = "https://api.coingecko.com/api/v3";
  var STORE_KEY = "crypto:key";

  /*
    Substituted only if COINGECKO_API_KEY is registered as a public variable.
    Left exactly as written when it is a secret, which is the recommended
    setup -- see the header comment.
  */
  var ENV_KEY = "%COINGECKO_API_KEY%";

  var CURRENCIES = [
    { id: "usd", label: "USD" },
    { id: "eur", label: "EUR" },
    { id: "gbp", label: "GBP" },
    { id: "jpy", label: "JPY" }
  ];

  /* How many coins the 7-day comparison plots. The categorical palette is
     assigned in fixed order and never cycled, so this caps at eight. */
  var COMPARE_COUNT = 5;

  function headers(key) {
    return key ? { "x-cg-demo-api-key": key } : undefined;
  }

  function load(currency, count, key, signal) {
    var markets = DB.fetchJson(
      API +
        "/coins/markets" +
        DB.query({
          vs_currency: currency,
          order: "market_cap_desc",
          per_page: count,
          page: 1,
          sparkline: true,
          price_change_percentage: "1h,24h,7d"
        }),
      { headers: headers(key), signal: signal }
    );

    var overview = DB.fetchJson(API + "/global", {
      headers: headers(key),
      signal: signal
    }).catch(function () {
      // The header tiles are worth having but not worth failing the page for.
      return null;
    });

    return Promise.all([markets, overview]).then(function (results) {
      return { coins: results[0] || [], overview: results[1] && results[1].data };
    });
  }

  /**
   * Rebases each coin's 7-day sparkline to 100 at the start of the window.
   *
   * Without this the chart cannot exist. Bitcoin trades near five figures and
   * a mid-cap coin near one, so plotting raw prices together needs two y-scales
   * -- and a dual-axis chart invites exactly the comparison it cannot support.
   * Indexed to a common base there is one axis, reading "percent moved since
   * seven days ago", which is the comparison anyone actually wants.
   */
  function indexedSeries(coins) {
    return coins.map(function (coin, index) {
      var prices = (coin.sparkline_in_7d && coin.sparkline_in_7d.price) || [];
      var base = prices.length ? prices[0] : 0;
      var step = 3600000;
      var end = Date.now();

      return {
        name: (coin.symbol || "").toUpperCase(),
        color: DB.seriesColor(index),
        points: !base
          ? []
          : prices.map(function (price, position) {
              return {
                x: end - (prices.length - 1 - position) * step,
                y: (price / base) * 100
              };
            })
      };
    });
  }

  function App() {
    var currencyStore = DB.useStored("crypto:currency", "usd");
    var currency = currencyStore[0];
    var setCurrency = currencyStore[1];

    var countStore = DB.useStored("crypto:count", "50");
    var count = countStore[0];
    var setCount = countStore[1];

    var keyStore = DB.useStored(STORE_KEY, "");
    var storedKey = keyStore[0];
    var setStoredKey = keyStore[1];

    var key = DB.envValue(ENV_KEY) || storedKey;

    var request = DB.useAsync(
      function (signal) { return load(currency, Number(count), key, signal); },
      [currency, count, key]
    );

    DB.useInterval(request.reload, 120);

    var payload = request.data || {};
    var coins = payload.coins || [];
    var overview = payload.overview;

    var series = DB.useMemo(
      function () { return indexedSeries(coins.slice(0, COMPARE_COUNT)); },
      [coins]
    );

    var advancing = coins.filter(function (coin) {
      return (coin.price_change_percentage_24h_in_currency || 0) > 0;
    }).length;

    var movers = DB.useMemo(
      function () {
        return coins
          .slice()
          .filter(function (coin) {
            return coin.price_change_percentage_24h_in_currency != null;
          })
          .sort(function (a, b) {
            return (
              Math.abs(b.price_change_percentage_24h_in_currency) -
              Math.abs(a.price_change_percentage_24h_in_currency)
            );
          })
          .slice(0, 10)
          .sort(function (a, b) {
            return (
              b.price_change_percentage_24h_in_currency -
              a.price_change_percentage_24h_in_currency
            );
          })
          .map(function (coin) {
            var change = coin.price_change_percentage_24h_in_currency;
            return {
              label: (coin.symbol || "").toUpperCase(),
              value: change,
              // Polarity, not identity: the two poles of a gain/loss reading,
              // and the signed number is printed at the end of every bar.
              color: change >= 0 ? "var(--pos)" : "var(--neg)"
            };
          });
      },
      [coins]
    );

    var dominance = DB.useMemo(
      function () {
        var caps = coins.slice(0, 8).map(function (coin) {
          return { label: (coin.symbol || "").toUpperCase(), value: coin.market_cap || 0 };
        });

        return caps;
      },
      [coins]
    );

    var columns = [
      {
        key: "market_cap_rank",
        label: "#",
        num: true,
        render: function (row) { return row.market_cap_rank || "--"; }
      },
      {
        key: "name",
        label: "Coin",
        render: function (row) {
          return html`<span class="cell-name">
            <img src=${row.image} alt="" loading="lazy" />
            <span>${row.name}</span>
            <span class="muted">${(row.symbol || "").toUpperCase()}</span>
          </span>`;
        }
      },
      {
        key: "current_price",
        label: "Price",
        num: true,
        render: function (row) { return DB.money(row.current_price, currency); }
      },
      {
        key: "price_change_percentage_1h_in_currency",
        label: "1h",
        num: true,
        render: function (row) {
          var change = row.price_change_percentage_1h_in_currency;
          return html`<span class=${"delta " + DB.signClass(change)}>${DB.percent(change, 1)}</span>`;
        }
      },
      {
        key: "price_change_percentage_24h_in_currency",
        label: "24h",
        num: true,
        render: function (row) {
          var change = row.price_change_percentage_24h_in_currency;
          return html`<span class=${"delta " + DB.signClass(change)}>${DB.percent(change, 1)}</span>`;
        }
      },
      {
        key: "price_change_percentage_7d_in_currency",
        label: "7d",
        num: true,
        render: function (row) {
          var change = row.price_change_percentage_7d_in_currency;
          return html`<span class=${"delta " + DB.signClass(change)}>${DB.percent(change, 1)}</span>`;
        }
      },
      {
        key: "market_cap",
        label: "Market cap",
        num: true,
        render: function (row) { return DB.compact(row.market_cap); }
      },
      {
        key: "total_volume",
        label: "Volume 24h",
        num: true,
        render: function (row) { return DB.compact(row.total_volume); }
      },
      {
        key: "sparkline",
        label: "7 days",
        sortable: false,
        render: function (row) {
          var change = row.price_change_percentage_7d_in_currency;
          return html`<${UI.Sparkline}
            values=${(row.sparkline_in_7d && row.sparkline_in_7d.price) || []}
            width=${104}
            height=${26}
            color=${change >= 0 ? "var(--pos)" : "var(--neg)"}
          />`;
        }
      }
    ];

    /*
      The paste-a-key card appears only when there is no key and nothing has
      ever loaded. CoinGecko's public tier works without one, so demanding a key
      up front would be asking for something the page does not need -- and once
      a load has succeeded, a later failure is a rate limit to wait out rather
      than a missing credential.

      Same rule as the weather and stocks dashboards; see the note there for why
      it is not written against the HTTP status.
    */
    var needsKey = !key && !request.updatedAt && !!request.error;

    if (needsKey) {
      return html`
        <div class="shell">
          <${UI.Topbar} title="Crypto Markets" subtitle="CoinGecko" />
          <${UI.KeyPrompt}
            title="CoinGecko is rate-limiting this browser"
            host="api.coingecko.com"
            placeholder="CG-..."
            onSave=${setStoredKey}
            onRetry=${request.reload}
            error=${request.error && request.error.message}
          >
            The public tier allows only a handful of calls a minute. A free demo
            key from coingecko.com raises that. Where the page is deployed with
            a credential proxy in front of it, register the key there instead
            and it will be attached for you.
          <//>
        </div>
      `;
    }

    var blocking = request.error && !coins.length;

    return html`
      <div class="shell">
        <${UI.Topbar}
          title="Crypto Markets"
          subtitle=${"Top " + count + " by market capitalisation, CoinGecko"}
          updatedAt=${request.updatedAt}
          loading=${request.loading}
          onReload=${request.reload}
        />

        <div class="filters">
          <div class="field">
            <label for="currency">Currency</label>
            <select
              id="currency"
              value=${currency}
              onChange=${function (event) { setCurrency(event.target.value); }}
            >
              ${CURRENCIES.map(function (option) {
                return html`<option key=${option.id} value=${option.id}>${option.label}</option>`;
              })}
            </select>
          </div>

          <div class="field">
            <span class="sr-only" id="count-label">Number of coins</span>
            <div class="segmented" role="group" aria-labelledby="count-label">
              ${["25", "50", "100"].map(function (option) {
                return html`<button
                  key=${option}
                  type="button"
                  aria-pressed=${String(option === count)}
                  onClick=${function () { setCount(option); }}
                >
                  Top ${option}
                </button>`;
              })}
            </div>
          </div>

          ${key
            ? html`<span class="badge">
                <span class="dot" style="background:var(--good)"></span>Key in use
              </span>`
            : null}

          ${request.error && coins.length
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
                  label="Total market cap"
                  value=${overview ? DB.moneyCompact(overview.total_market_cap[currency], currency) : "--"}
                  delta=${overview ? overview.market_cap_change_percentage_24h_usd : null}
                  foot="24h"
                />
                <${UI.StatTile}
                  label="24h volume"
                  value=${overview ? DB.moneyCompact(overview.total_volume[currency], currency) : "--"}
                  foot=${overview ? DB.localeNumber(overview.active_cryptocurrencies) + " active coins" : ""}
                />
                <${UI.StatTile}
                  label="Bitcoin dominance"
                  value=${overview && overview.market_cap_percentage
                    ? overview.market_cap_percentage.btc.toFixed(1) + "%"
                    : "--"}
                  foot=${overview && overview.market_cap_percentage
                    ? "Ether " + overview.market_cap_percentage.eth.toFixed(1) + "%"
                    : ""}
                />
                <${UI.StatTile}
                  label="Advancing"
                  value=${coins.length ? advancing + " / " + coins.length : "--"}
                  foot="Up over the last 24 hours"
                />

                <${UI.Card}
                  span="8"
                  title=${"Seven days, indexed to 100"}
                  sub=${"The top " + COMPARE_COUNT + " coins rebased to a common start, so one axis serves them all. Click a symbol to hide it."}
                >
                  ${request.loading && !coins.length
                    ? html`<${UI.Loading} height=${210} />`
                    : html`<${UI.LineChart}
                        series=${series}
                        height=${240}
                        formatY=${function (value) { return value.toFixed(0); }}
                        formatX=${DB.shortDate}
                        label="Seven-day indexed price performance"
                      />`}
                <//>

                <${UI.Card}
                  span="4"
                  title="Biggest movers, 24h"
                  sub="Ranked by absolute move; the signed figure sits on every bar."
                >
                  ${request.loading && !coins.length
                    ? html`<${UI.Loading} height=${210} />`
                    : html`<${UI.RankedBars}
                        data=${movers}
                        labelWidth=${58}
                        rowHeight=${26}
                        formatValue=${function (value) { return DB.percent(value, 1); }}
                        label="Largest 24-hour price moves"
                      />`}
                <//>

                <${UI.Card}
                  span="12"
                  title="Market capitalisation by coin"
                  sub="The eight largest, on a shared scale."
                >
                  ${request.loading && !coins.length
                    ? html`<${UI.Loading} height=${160} />`
                    : html`<${UI.BarChart}
                        data=${dominance}
                        height=${190}
                        valueLabel="Market cap"
                        formatValue=${function (value) { return DB.moneyCompact(value, currency); }}
                        formatAxis=${DB.moneyAxis(
                          Math.max.apply(null, dominance.map(function (row) { return row.value; }).concat([0])),
                          currency
                        )}
                        label="Market capitalisation of the eight largest coins"
                      />`}
                <//>

                <${UI.Card}
                  span="12"
                  title="All coins"
                  sub="Every column sorts. Sparklines cover the same seven days."
                >
                  ${request.loading && !coins.length
                    ? html`<${UI.Loading} height=${240} />`
                    : html`<${UI.DataTable}
                        columns=${columns}
                        rows=${coins}
                        initialSort="market_cap"
                        initialDir="desc"
                        limit=${Number(count)}
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
