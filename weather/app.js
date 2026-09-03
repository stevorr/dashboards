/*
  Weather Forecast -- current conditions and five days ahead, from OpenWeather.

  The credential here is mandatory and travels as a query parameter (`appid`),
  which is the case a credential proxy exists for: register OPENWEATHER_API_KEY
  as a SECRET variable and give the api.openweathermap.org target a query-located
  credential named `appid`.

  The page then never sends one. `DB.query` drops empty values, so with no key
  in hand the request goes out without an `appid` at all and the proxy adds it
  server-side. Served as a plain static page with no proxy in front of it, the
  first call comes back unauthorised and the setup card asks for a key, which is
  kept in that browser only.
*/

(function (global) {
  "use strict";

  var DB = global.DB;
  var UI = global.DBUI;
  var html = DB.html;

  var API = "https://api.openweathermap.org/data/2.5";
  var STORE_KEY = "weather:key";

  /* Substituted only if OPENWEATHER_API_KEY is registered as a public
     variable. Left as written when it is a secret, which is the setup this
     dashboard is designed around -- see the header comment. */
  var ENV_KEY = "%OPENWEATHER_API_KEY%";

  var UNITS = {
    metric: { id: "metric", label: "°C", temp: "°C", speed: "m/s", short: "Metric" },
    imperial: { id: "imperial", label: "°F", temp: "°F", speed: "mph", short: "Imperial" }
  };

  var QUICK_CITIES = ["London", "New York", "Tokyo", "Sydney", "Nairobi", "São Paulo"];

  function load(city, units, key, signal) {
    var params = { q: city, units: units, appid: key };

    return Promise.all([
      DB.fetchJson(API + "/weather" + DB.query(params), { signal: signal }),
      DB.fetchJson(API + "/forecast" + DB.query(params), { signal: signal })
    ]).then(function (results) {
      var forecast = (results[1].list || []).map(function (entry) {
        return {
          at: entry.dt * 1000,
          temp: entry.main && entry.main.temp,
          feels: entry.main && entry.main.feels_like,
          humidity: entry.main && entry.main.humidity,
          pressure: entry.main && entry.main.pressure,
          wind: entry.wind && entry.wind.speed,
          // The API omits `pop` rather than sending zero on a dry step.
          pop: (entry.pop || 0) * 100,
          rain: (entry.rain && entry.rain["3h"]) || 0,
          summary: entry.weather && entry.weather[0] ? entry.weather[0].main : "",
          detail: entry.weather && entry.weather[0] ? entry.weather[0].description : ""
        };
      });

      return { current: results[0], forecast: forecast, place: results[1].city };
    });
  }

  /**
   * Daily highs and lows from the three-hourly steps.
   *
   * Grouped by the viewer's local calendar day rather than by UTC: a forecast
   * that says "Tuesday" should mean the Tuesday the reader is living in.
   */
  function daily(forecast) {
    var days = [];
    var index = {};

    forecast.forEach(function (step) {
      var date = new Date(step.at);
      var key = date.getFullYear() + "-" + date.getMonth() + "-" + date.getDate();

      if (!index[key]) {
        index[key] = { at: date.getTime(), high: -Infinity, low: Infinity, pop: 0, rain: 0 };
        days.push(index[key]);
      }

      var day = index[key];
      if (step.temp != null) {
        day.high = Math.max(day.high, step.temp);
        day.low = Math.min(day.low, step.temp);
      }
      day.pop = Math.max(day.pop, step.pop);
      day.rain += step.rain;
    });

    return days.filter(function (day) {
      return isFinite(day.high);
    });
  }

  function App() {
    var cityStore = DB.useStored("weather:city", "London");
    var city = cityStore[0];
    var setCity = cityStore[1];

    var unitStore = DB.useStored("weather:units", "metric");
    var unitId = unitStore[0];
    var setUnitId = unitStore[1];
    var units = UNITS[unitId] || UNITS.metric;

    var keyStore = DB.useStored(STORE_KEY, "");
    var storedKey = keyStore[0];
    var setStoredKey = keyStore[1];

    var draftState = DB.useState(city);
    var draft = draftState[0];
    var setDraft = draftState[1];

    var key = DB.envValue(ENV_KEY) || storedKey;

    var request = DB.useAsync(
      function (signal) { return load(city, unitId, key, signal); },
      [city, unitId, key]
    );

    DB.useInterval(request.reload, 600);

    var payload = request.data || {};
    var current = payload.current;
    var forecast = payload.forecast || [];
    var place = payload.place;

    var days = DB.useMemo(function () { return daily(forecast); }, [forecast]);

    var tempSeries = DB.useMemo(
      function () {
        return [
          {
            name: "Temperature",
            color: DB.seriesColor(0),
            points: forecast.map(function (step) { return { x: step.at, y: step.temp }; })
          },
          {
            name: "Feels like",
            color: DB.seriesColor(1),
            points: forecast.map(function (step) { return { x: step.at, y: step.feels }; })
          }
        ];
      },
      [forecast]
    );

    var rangeSeries = DB.useMemo(
      function () {
        return [
          {
            name: "Daily high",
            color: DB.seriesColor(1),
            points: days.map(function (day) { return { x: day.at, y: day.high }; })
          },
          {
            name: "Daily low",
            color: DB.seriesColor(0),
            points: days.map(function (day) { return { x: day.at, y: day.low }; })
          }
        ];
      },
      [days]
    );

    var precipitation = DB.useMemo(
      function () {
        return forecast.slice(0, 24).map(function (step) {
          return {
            // Weekday and hour, not the clock alone: these steps span three
            // days, and a bare "7 PM" appears three times meaning three things.
            label: new Date(step.at).toLocaleString(undefined, {
              weekday: "short",
              hour: "numeric"
            }),
            value: step.pop,
            // Sequential: one hue, light to dark with magnitude. Chance of rain
            // is a continuous quantity, not a set of categories.
            color:
              step.pop >= 70
                ? "var(--seq-600)"
                : step.pop >= 40
                  ? "var(--seq-400)"
                  : step.pop >= 15
                    ? "var(--seq-300)"
                    : "var(--seq-200)",
            note: { label: "Expected", value: step.rain.toFixed(1) + " mm" }
          };
        });
      },
      [forecast]
    );

    function degrees(value) {
      return value == null ? "--" : Math.round(value) + units.temp;
    }

    /*
      Asked for only after a call has actually failed and none has ever
      succeeded, rather than up front whenever the page holds no key -- holding
      none is the correct state when a proxy is attaching one on the way out,
      and in that arrangement the first load simply works.

      Any failure counts, not only a 401. An API that refuses without CORS
      headers reaches script as an opaque network error, so keying off the
      status alone would leave those dashboards with no way to ask. The card
      shows what the browser actually reported, so a genuine connectivity
      problem is still legible rather than being reported as a missing key.

      Placed below every hook rather than beside the check that produces it:
      saving a key flips this, and returning early above the memos would change
      how many hooks this component calls between two renders.
    */
    var mustAsk = !key && !request.updatedAt && !!request.error;

    if (mustAsk) {
      return html`
        <div class="shell">
          <${UI.Topbar} title="Weather Forecast" subtitle="OpenWeather" />
          <${UI.KeyPrompt}
            title="This dashboard needs an OpenWeather key"
            host="api.openweathermap.org"
            placeholder="Your OpenWeather API key"
            onSave=${setStoredKey}
            onRetry=${request.reload}
            error=${request.error && request.error.message}
          >
            OpenWeather has no anonymous tier. A free account gives you a key
            good for 60 calls a minute. Deployed behind a credential proxy you
            would instead register it as a secret with a query-located
            credential named <code>appid</code>, and this card would never
            appear.
          <//>
        </div>
      `;
    }

    var columns = [
      {
        key: "at",
        label: "When",
        render: function (row) { return DB.dateTime(row.at); }
      },
      {
        key: "detail",
        label: "Conditions",
        render: function (row) {
          return html`<span style="text-transform:capitalize">${row.detail}</span>`;
        }
      },
      {
        key: "temp",
        label: "Temp",
        num: true,
        render: function (row) { return degrees(row.temp); }
      },
      {
        key: "feels",
        label: "Feels like",
        num: true,
        render: function (row) { return degrees(row.feels); }
      },
      {
        key: "pop",
        label: "Rain chance",
        num: true,
        render: function (row) { return Math.round(row.pop) + "%"; }
      },
      {
        key: "wind",
        label: "Wind",
        num: true,
        render: function (row) {
          return row.wind == null ? "--" : row.wind.toFixed(1) + " " + units.speed;
        }
      },
      {
        key: "humidity",
        label: "Humidity",
        num: true,
        render: function (row) { return row.humidity == null ? "--" : row.humidity + "%"; }
      }
    ];

    var blocking = request.error && !forecast.length;

    return html`
      <div class="shell">
        <${UI.Topbar}
          title="Weather Forecast"
          subtitle=${place ? place.name + ", " + place.country : "OpenWeather"}
          updatedAt=${request.updatedAt}
          loading=${request.loading}
          onReload=${request.reload}
        />

        <div class="filters">
          <form
            class="field"
            onSubmit=${function (event) {
              event.preventDefault();
              if (draft.trim()) setCity(draft.trim());
            }}
          >
            <label for="city">City</label>
            <input
              id="city"
              type="search"
              value=${draft}
              placeholder="City name"
              onInput=${function (event) { setDraft(event.target.value); }}
            />
            <button type="submit">Go</button>
          </form>

          <div class="segmented" role="group" aria-label="Units">
            ${Object.keys(UNITS).map(function (id) {
              return html`<button
                key=${id}
                type="button"
                aria-pressed=${String(id === unitId)}
                onClick=${function () { setUnitId(id); }}
              >
                ${UNITS[id].short}
              </button>`;
            })}
          </div>

          ${QUICK_CITIES.map(function (name) {
            return html`<button
              key=${name}
              type="button"
              onClick=${function () {
                setDraft(name);
                setCity(name);
              }}
              style=${name === city ? "border-color:var(--series-1);color:var(--series-1)" : null}
            >
              ${name}
            </button>`;
          })}

          ${request.error && forecast.length
            ? html`<span class="badge" title=${request.error.message}>
                <span class="dot" style="background:var(--warning)"></span>
                Showing last good data
              </span>`
            : null}
        </div>

        ${blocking
          ? html`<${UI.Card}>
              <${UI.ErrorState}
                title=${request.error.status === 404 ? "No such city" : undefined}
                message=${request.error.status === 404
                  ? "OpenWeather has no record of “" + city + "”. Try a different spelling, or add a country code such as “Paris,FR”."
                  : request.error.message}
                onRetry=${request.reload}
              />
            <//>`
          : html`
              <div class="grid">
                <${UI.StatTile}
                  label="Temperature now"
                  value=${current ? degrees(current.main.temp) : "--"}
                  foot=${current && current.weather && current.weather[0]
                    ? current.weather[0].description
                    : ""}
                />
                <${UI.StatTile}
                  label="Feels like"
                  value=${current ? degrees(current.main.feels_like) : "--"}
                  foot=${current
                    ? "Range today " +
                      degrees(current.main.temp_min) +
                      " to " +
                      degrees(current.main.temp_max)
                    : ""}
                />
                <${UI.StatTile}
                  label="Humidity"
                  value=${current ? current.main.humidity + "%" : "--"}
                  foot=${current ? current.main.pressure + " hPa" : ""}
                />
                <${UI.StatTile}
                  label="Wind"
                  value=${current && current.wind
                    ? current.wind.speed.toFixed(1) + " " + units.speed
                    : "--"}
                  foot=${current && current.clouds ? current.clouds.all + "% cloud cover" : ""}
                />

                <${UI.Card}
                  span="8"
                  title="Five days, three-hour steps"
                  sub=${"Temperature against what it feels like, both in " + units.label + " so one axis serves both."}
                >
                  ${request.loading && !forecast.length
                    ? html`<${UI.Loading} height=${210} />`
                    : html`<${UI.LineChart}
                        series=${tempSeries}
                        height=${240}
                        area=${true}
                        formatY=${function (value) { return Math.round(value) + units.temp; }}
                        formatX=${DB.shortDate}
                        label="Forecast temperature over five days"
                      />`}
                <//>

                <${UI.Card}
                  span="4"
                  title="Daily high and low"
                  sub="The spread each day, from the three-hourly steps."
                >
                  ${request.loading && !days.length
                    ? html`<${UI.Loading} height=${210} />`
                    : html`<${UI.LineChart}
                        series=${rangeSeries}
                        height=${240}
                        formatY=${function (value) { return Math.round(value) + units.temp; }}
                        formatX=${DB.shortDate}
                        label="Daily high and low temperature"
                      />`}
                <//>

                <${UI.Card}
                  span="12"
                  title="Chance of precipitation"
                  sub="The next three days in three-hour steps. Darker means likelier; hover for expected millimetres."
                >
                  ${request.loading && !forecast.length
                    ? html`<${UI.Loading} height=${160} />`
                    : html`<${UI.BarChart}
                        data=${precipitation}
                        height=${190}
                        valueLabel="Chance"
                        formatValue=${function (value) { return Math.round(value) + "%"; }}
                        label="Probability of precipitation over the next three days"
                      />`}
                <//>

                <${UI.Card}
                  span="12"
                  title="Forecast detail"
                  sub="Every column sorts."
                >
                  ${request.loading && !forecast.length
                    ? html`<${UI.Loading} height=${220} />`
                    : html`<${UI.DataTable}
                        columns=${columns}
                        rows=${forecast}
                        initialSort="at"
                        initialDir="asc"
                        limit=${40}
                        rowKey=${function (row) { return row.at; }}
                      />`}
                <//>
              </div>
            `}
      </div>
    `;
  }

  DB.render(html`<${App} />`, document.getElementById("root"));
})(window);
