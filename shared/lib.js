/*
  Shared runtime for every dashboard in this repo.

  Deliberately a classic script, not an ES module. These dashboards are built to
  run under a host that serves a page by fetching the entry HTML and inlining
  the same-repo files its <script src> tags name -- it does not follow `import`
  statements, and the document it produces runs in a sandboxed frame with no
  origin, so a relative import would have nothing to resolve against. Every
  shared file therefore hangs itself off one global and the entry document lists
  them in order.

  Depends on htm/preact/standalone, loaded from a CDN before this file.
*/

(function (global) {
  "use strict";

  var htmPreact = global.htmPreact;

  if (!htmPreact) {
    throw new Error(
      "htm/preact standalone did not load. Check the CDN <script> tag above this one."
    );
  }

  var html = htmPreact.html;

  /* ------------------------------------------------------------------ *
   * Environment values
   * ------------------------------------------------------------------ */

  /**
   * Whether a value is still an unsubstituted environment placeholder.
   *
   * The host rewrites %NAME% in the source to the stored value of that
   * variable, but only for variables marked public -- a secret is left exactly
   * as written so it never reaches the browser, and a host-side proxy attaches
   * it after the request leaves. Either way an untouched placeholder means
   * "this page has no value for that name", which is the question every caller
   * is really asking.
   *
   * Built without writing a literal placeholder anywhere, since that would make
   * this file's own source a substitution target.
   */
  function isPlaceholder(raw) {
    return (
      typeof raw === "string" &&
      raw.length > 2 &&
      raw.charAt(0) === "%" &&
      raw.charAt(raw.length - 1) === "%" &&
      /^[A-Z_][A-Z0-9_]*$/.test(raw.slice(1, raw.length - 1))
    );
  }

  /** The substituted value, or "" when nothing was substituted. */
  function envValue(raw) {
    return isPlaceholder(raw) || raw == null ? "" : String(raw).trim();
  }

  /* ------------------------------------------------------------------ *
   * Storage -- every access guarded
   * ------------------------------------------------------------------ */

  /*
    The sandbox can refuse storage outright, in which case even reading the
    property throws. Nothing here is load-bearing, so a failure degrades to "no
    remembered value" rather than a broken page.
  */
  function readStore(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      if (value == null || value === "") global.localStorage.removeItem(key);
      else global.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Fetching
   * ------------------------------------------------------------------ */

  function HttpError(message, status, kind) {
    var error = new Error(message);
    error.status = status;
    error.kind = kind;
    return error;
  }

  /**
   * Fetches JSON and turns every failure into one carrying a message worth
   * showing.
   *
   * The interesting case is `blocked`. A sandboxed host frame typically permits
   * outbound calls only to hosts it has been told about, so a request to an
   * unregistered API fails at the network layer with no HTTP status at all --
   * and so does an ordinary offline browser. Both are worth naming the origin
   * for, because "failed to fetch" hides which one happened.
   */
  function fetchJson(url, options) {
    var settings = options || {};

    return global
      .fetch(url, { headers: settings.headers, signal: settings.signal })
      .catch(function (error) {
        if (error && error.name === "AbortError") throw error;

        throw HttpError(
          "The browser could not reach " +
            new URL(url).origin +
            ". Check your connection, and if this page is running inside a " +
            "sandboxed frame, check that this host is allowed to be called.",
          0,
          "blocked"
        );
      })
      .then(function (response) {
        if (response.ok) return response.json();

        if (response.status === 401 || response.status === 403) {
          throw HttpError(
            "The API rejected the credential for this request (HTTP " +
              response.status +
              ").",
            response.status,
            "auth"
          );
        }

        if (response.status === 429) {
          throw HttpError(
            "Rate limit reached. The free tier allows a limited number of " +
              "calls per minute -- wait a moment and refresh.",
            429,
            "rate-limit"
          );
        }

        throw HttpError(
          "The API returned HTTP " + response.status + ".",
          response.status,
          "http"
        );
      });
  }

  /** Builds a query string, dropping empty values so no bare `&key=` is sent. */
  function query(params) {
    var parts = [];

    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null || value === "") return;
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
    });

    return parts.length ? "?" + parts.join("&") : "";
  }

  /* ------------------------------------------------------------------ *
   * Hooks
   * ------------------------------------------------------------------ */

  var useState = htmPreact.useState;
  var useEffect = htmPreact.useEffect;
  var useMemo = htmPreact.useMemo;
  var useRef = htmPreact.useRef;
  var useCallback = htmPreact.useCallback;

  /**
   * Runs an async loader whenever `deps` change, with the previous run's result
   * kept on screen while the next one is in flight.
   *
   * Holding the stale data is the point: these dashboards refresh on a timer
   * and on filter changes, and blanking every chart back to a skeleton each
   * time makes a working dashboard look broken. `loading` is exposed separately
   * so the header can say a refresh is happening without the body moving.
   */
  function useAsync(loader, deps) {
    var state = useState({ data: null, error: null, loading: true });
    var value = state[0];
    var setValue = state[1];
    var counter = useState(0);
    var nonce = counter[0];
    var setNonce = counter[1];
    var stampState = useState(null);
    var stamp = stampState[0];
    var setStamp = stampState[1];

    useEffect(
      function () {
        var live = true;
        var controller =
          typeof AbortController === "undefined" ? null : new AbortController();

        setValue(function (previous) {
          return { data: previous.data, error: previous.error, loading: true };
        });

        loader(controller ? controller.signal : undefined)
          .then(function (data) {
            if (!live) return;
            setValue({ data: data, error: null, loading: false });
            setStamp(new Date());
          })
          .catch(function (error) {
            if (!live || (error && error.name === "AbortError")) return;
            setValue(function (previous) {
              return { data: previous.data, error: error, loading: false };
            });
          });

        return function () {
          live = false;
          if (controller) controller.abort();
        };
      },
      deps.concat([nonce])
    );

    return {
      data: value.data,
      error: value.error,
      loading: value.loading,
      updatedAt: stamp,
      reload: useCallback(function () {
        setNonce(function (n) {
          return n + 1;
        });
      }, [])
    };
  }

  /** Calls `onTick` every `seconds`, and never while the tab is hidden. */
  function useInterval(onTick, seconds) {
    var saved = useRef(onTick);
    saved.current = onTick;

    useEffect(
      function () {
        if (!seconds) return undefined;

        var id = global.setInterval(function () {
          if (global.document.hidden) return;
          saved.current();
        }, seconds * 1000);

        return function () {
          global.clearInterval(id);
        };
      },
      [seconds]
    );
  }

  /** A value mirrored into localStorage, degrading to plain state if refused. */
  function useStored(key, initial) {
    var state = useState(function () {
      var raw = readStore(key);
      return raw === null ? initial : raw;
    });

    var value = state[0];
    var set = state[1];

    var update = useCallback(
      function (next) {
        set(next);
        writeStore(key, next);
      },
      [key]
    );

    return [value, update];
  }

  /**
   * The active colour scheme, and a toggle.
   *
   * Stamped on <html> rather than tracked only in state so the CSS token blocks
   * decide the colours -- the charts read the same custom properties as the
   * chrome, so nothing has to be re-themed in JavaScript.
   */
  function useTheme() {
    var stored = useStored("db:theme", "");
    var choice = stored[0];
    var setChoice = stored[1];

    var systemDark =
      typeof global.matchMedia === "function" &&
      global.matchMedia("(prefers-color-scheme: dark)").matches;

    var resolved = choice || (systemDark ? "dark" : "light");

    useEffect(
      function () {
        if (choice) global.document.documentElement.setAttribute("data-theme", choice);
        else global.document.documentElement.removeAttribute("data-theme");
      },
      [choice]
    );

    return [
      resolved,
      function () {
        setChoice(resolved === "dark" ? "light" : "dark");
      }
    ];
  }

  /** Tracks an element's rendered width so a chart can lay itself out. */
  function useWidth(fallback) {
    var ref = useRef(null);
    var state = useState(fallback || 640);
    var width = state[0];
    var setWidth = state[1];

    useEffect(function () {
      var node = ref.current;
      if (!node) return undefined;

      var measure = function () {
        var next = node.clientWidth;
        if (next > 0) setWidth(next);
      };

      measure();

      if (typeof ResizeObserver !== "undefined") {
        var observer = new ResizeObserver(measure);
        observer.observe(node);
        return function () {
          observer.disconnect();
        };
      }

      global.addEventListener("resize", measure);
      return function () {
        global.removeEventListener("resize", measure);
      };
    }, []);

    return [ref, width];
  }

  /* ------------------------------------------------------------------ *
   * Scales and ticks
   * ------------------------------------------------------------------ */

  function extent(values) {
    var min = Infinity;
    var max = -Infinity;

    for (var i = 0; i < values.length; i++) {
      var value = values[i];
      if (value == null || !isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }

    if (min === Infinity) return [0, 1];
    if (min === max) return min === 0 ? [0, 1] : [min - Math.abs(min) * 0.1, max + Math.abs(max) * 0.1];

    return [min, max];
  }

  function scale(domain, range) {
    var d0 = domain[0];
    var d1 = domain[1];
    var r0 = range[0];
    var r1 = range[1];
    var span = d1 - d0 || 1;

    return function (value) {
      return r0 + ((value - d0) / span) * (r1 - r0);
    };
  }

  /** Round tick values covering [min, max], at most `count` of them. */
  function ticks(min, max, count) {
    var target = count || 5;
    var span = max - min;

    if (!isFinite(span) || span <= 0) return [min];

    var rough = span / target;
    var magnitude = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var normalized = rough / magnitude;
    var step;

    if (normalized >= 7.5) step = 10 * magnitude;
    else if (normalized >= 3.5) step = 5 * magnitude;
    else if (normalized >= 1.5) step = 2 * magnitude;
    else step = magnitude;

    var out = [];
    var start = Math.ceil(min / step) * step;

    for (var value = start; value <= max + step * 0.001; value += step) {
      out.push(Math.abs(value) < step * 1e-9 ? 0 : value);
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * Formatting
   * ------------------------------------------------------------------ */

  function localeNumber(value, options) {
    if (value == null || !isFinite(value)) return "--";
    return value.toLocaleString(undefined, options);
  }

  /** 1_234_567 -> "1.23M". Used on axes and in dense tiles. */
  function compact(value, digits) {
    if (value == null || !isFinite(value)) return "--";

    var abs = Math.abs(value);
    var units = [
      [1e12, "T"],
      [1e9, "B"],
      [1e6, "M"],
      [1e3, "K"]
    ];

    for (var i = 0; i < units.length; i++) {
      if (abs >= units[i][0]) {
        var scaled = value / units[i][0];
        return (
          scaled.toFixed(digits === undefined ? (Math.abs(scaled) < 10 ? 2 : 1) : digits) +
          units[i][1]
        );
      }
    }

    return localeNumber(value, { maximumFractionDigits: digits === undefined ? 2 : digits });
  }

  var UNITS = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"]
  ];

  /**
   * A formatter that gives every tick on one axis the same unit.
   *
   * `compact` picks a unit per value, which is right for a lone figure and
   * wrong for an axis: ticks of 1.50T and 500.0B are the same axis asking to be
   * read two ways. Choosing the unit once from the largest tick fixes the
   * scale for all of them.
   */
  function compactAxis(max) {
    var abs = Math.abs(max);
    var unit = null;

    for (var i = 0; i < UNITS.length; i++) {
      if (abs >= UNITS[i][0]) {
        unit = UNITS[i];
        break;
      }
    }

    if (!unit) {
      return function (value) {
        return localeNumber(value, { maximumFractionDigits: abs < 10 ? 2 : 0 });
      };
    }

    var scaled = abs / unit[0];
    var digits = scaled < 3 ? 2 : scaled < 20 ? 1 : 0;

    return function (value) {
      // Zero gets no unit. "$0.0T" is a correct reading of nothing and an
      // absurd one to print on an axis.
      if (value === 0) return "0";
      return (value / unit[0]).toFixed(digits) + unit[1];
    };
  }

  /** The locale's symbol for a currency code, or the code itself as a fallback. */
  function currencySymbol(currency) {
    var code = (currency || "usd").toUpperCase();

    try {
      var parts = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: code,
        maximumFractionDigits: 0
      }).formatToParts(0);

      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === "currency") return parts[i].value;
      }
    } catch (error) {
      /* Falls through to the code. */
    }

    return code + " ";
  }

  /** "$2.74T" -- for headline figures, where full precision is unreadable. */
  function moneyCompact(value, currency) {
    if (value == null || !isFinite(value)) return "--";
    return (value < 0 ? "-" : "") + currencySymbol(currency) + compact(Math.abs(value));
  }

  /** `compactAxis` with a currency symbol -- one unit across the whole axis. */
  function moneyAxis(max, currency) {
    var format = compactAxis(max);
    var symbol = currencySymbol(currency);

    return function (value) {
      if (value == null || !isFinite(value)) return "--";
      if (value === 0) return symbol + "0";
      return (value < 0 ? "-" : "") + symbol + format(Math.abs(value));
    };
  }

  /**
   * Money, with the precision the magnitude actually deserves: a $0.000012 coin
   * and a $81,195 coin cannot share a fraction-digit setting.
   */
  function money(value, currency) {
    if (value == null || !isFinite(value)) return "--";

    var code = (currency || "usd").toUpperCase();
    var abs = Math.abs(value);
    var digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 8;

    try {
      return value.toLocaleString(undefined, {
        style: "currency",
        currency: code,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      });
    } catch (error) {
      return code + " " + localeNumber(value, { maximumFractionDigits: digits });
    }
  }

  function percent(value, digits) {
    if (value == null || !isFinite(value)) return "--";
    var fixed = value.toFixed(digits === undefined ? 2 : digits);
    return (value > 0 ? "+" : "") + fixed + "%";
  }

  function signClass(value) {
    if (value == null || !isFinite(value) || value === 0) return "flat";
    return value > 0 ? "up" : "down";
  }

  function clockTime(date) {
    return new Date(date).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function shortDate(date) {
    return new Date(date).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric"
    });
  }

  function dateTime(date) {
    return new Date(date).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  /** "4m ago" -- coarse on purpose, these feeds update on the order of minutes. */
  function relative(date) {
    var seconds = (Date.now() - new Date(date).getTime()) / 1000;

    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.round(seconds / 60) + "m ago";
    if (seconds < 86400) return Math.round(seconds / 3600) + "h ago";
    return Math.round(seconds / 86400) + "d ago";
  }

  /* ------------------------------------------------------------------ *
   * Misc
   * ------------------------------------------------------------------ */

  /** The categorical slot for index i, assigned in fixed order and never cycled. */
  function seriesColor(index) {
    return "var(--series-" + (Math.min(index, 7) + 1) + ")";
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sum(values) {
    return values.reduce(function (total, value) {
      return total + (isFinite(value) ? value : 0);
    }, 0);
  }

  function mean(values) {
    var usable = values.filter(function (value) {
      return value != null && isFinite(value);
    });

    return usable.length ? sum(usable) / usable.length : null;
  }

  function classes() {
    return Array.prototype.slice
      .call(arguments)
      .filter(Boolean)
      .join(" ");
  }

  global.DB = {
    html: html,
    render: htmPreact.render,
    useState: useState,
    useEffect: useEffect,
    useMemo: useMemo,
    useRef: useRef,
    useCallback: useCallback,

    isPlaceholder: isPlaceholder,
    envValue: envValue,
    readStore: readStore,
    writeStore: writeStore,

    fetchJson: fetchJson,
    query: query,

    useAsync: useAsync,
    useInterval: useInterval,
    useStored: useStored,
    useTheme: useTheme,
    useWidth: useWidth,

    extent: extent,
    scale: scale,
    ticks: ticks,

    localeNumber: localeNumber,
    compact: compact,
    compactAxis: compactAxis,
    currencySymbol: currencySymbol,
    moneyCompact: moneyCompact,
    moneyAxis: moneyAxis,
    money: money,
    percent: percent,
    signClass: signClass,
    clockTime: clockTime,
    shortDate: shortDate,
    dateTime: dateTime,
    relative: relative,

    seriesColor: seriesColor,
    clamp: clamp,
    sum: sum,
    mean: mean,
    classes: classes
  };
})(window);
