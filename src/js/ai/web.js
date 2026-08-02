/**
 * web.js — AI 助手联网层（第五轮增量，仅原生 fetch）
 *   weather(city)：Open-Meteo geocoding + forecast（免费无 Key，支持 CORS）
 *   wiki(topic)：Wikipedia REST v1 词条摘要（免费无 Key，支持 CORS）
 *   news(query)（P1）：Tavily / SerpAPI 新闻搜索（需 Key，Key 仅存本机 localStorage）
 * 统一错误归一化 Promise<{ok, err?, text?}>：
 *   not-found / timeout / network / server / disabled / no-key / unknown
 * 挂载到 window.App.AI.Web。
 */
(function () {
  'use strict';

  var Config = window.App.Config;
  var Store = window.App.Store;

  /* ================= 错误文案 ================= */

  var ERR_MAP = {
    "not-found": "未找到相关结果，请换个说法试试",
    "timeout": "请求超时，请稍后再试",
    "network": "网络异常，请检查网络后重试",
    "server": "服务暂时不可用，请稍后再试",
    "disabled": "该联网功能已在设置中关闭，可在 AI 设置 → 联网搜索 中开启",
    "no-key": "联网新闻搜索需要配置 API Key：设置 → AI 设置 → 联网搜索",
    "unknown": "服务返回异常，请稍后再试"
  };

  /** 错误类型 → 用户友好文案 */
  function errText(err) {
    return ERR_MAP[err] || ERR_MAP.unknown;
  }

  /* ================= 统一请求（fetch + 超时 + 错误归一化） ================= */

  /**
   * 原生 fetch 封装：AbortController 超时，错误归一化。
   * @param {string} url
   * @param {{method?: string, headers?: Object, body?: Object, timeout?: number}} [opts]
   * @returns {Promise<{ok: boolean, json?: Object, err?: string, text?: string}>}
   */
  function request(url, opts) {
    opts = opts || {};
    var timeout = opts.timeout || Config.WEB_TIMEOUT_MS;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout);
    var init = {
      method: opts.method || "GET",
      headers: opts.headers || {},
      signal: controller.signal
    };
    if (opts.body != null) init.body = JSON.stringify(opts.body);

    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          if (res.status === 404) {
            return { ok: false, err: "not-found", text: errText("not-found") };
          }
          if (res.status >= 500) {
            return { ok: false, err: "server", text: errText("server") };
          }
          return { ok: false, err: "unknown", text: errText("unknown") };
        }
        return { ok: true, json: json };
      });
    }).catch(function (e) {
      if (e && e.name === "AbortError") {
        return { ok: false, err: "timeout", text: errText("timeout") };
      }
      return { ok: false, err: "network", text: errText("network") };
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  /* ================= 天气（Open-Meteo） ================= */

  /** WMO 天气码 → 中文 + emoji */
  function wmoDesc(code) {
    if (code === 0) return { emoji: "☀️", text: "晴" };
    if (code === 1 || code === 2) return { emoji: "⛅", text: "多云" };
    if (code === 3) return { emoji: "☁️", text: "阴" };
    if (code >= 45 && code <= 48) return { emoji: "🌫", text: "雾" };
    if (code >= 51 && code <= 67) return { emoji: "🌦", text: "雨" };
    if (code >= 71 && code <= 77) return { emoji: "❄️", text: "雪" };
    if (code === 80 || code === 81 || code === 82) return { emoji: "🌧", text: "阵雨" };
    if (code === 85 || code === 86) return { emoji: "❄️", text: "阵雪" };
    if (code >= 95 && code <= 99) return { emoji: "⛈", text: "雷暴" };
    return { emoji: "🌤", text: "未知" };
  }

  /**
   * 查询城市实时天气：geocoding → forecast。
   * @param {string} city
   * @returns {Promise<{ok: boolean, data?: {city, temp, desc, emoji, max, min, wind, humidity}, err?: string, text?: string}>}
   */
  function weather(city) {
    city = String(city == null ? "" : city).trim();
    if (!city) {
      return Promise.resolve({ ok: false, err: "not-found", text: errText("not-found") });
    }
    var geoUrl = Config.WEB_WEATHER_GEO_URL +
      "?name=" + encodeURIComponent(city) + "&count=1&language=zh";
    return request(geoUrl, { timeout: Config.WEB_TIMEOUT_MS }).then(function (geo) {
      if (!geo.ok) return geo;
      var results = geo.json && geo.json.results;
      if (!results || !results.length) {
        return { ok: false, err: "not-found", text: "未找到城市「" + city + "」，请检查城市名后重试" };
      }
      var loc = results[0];
      var displayCity = loc.name || city;
      if (loc.admin1 && loc.admin1 !== displayCity && loc.country && loc.country !== "CN") {
        displayCity += "·" + loc.admin1;
      }
      var fcUrl = Config.WEB_WEATHER_FORECAST_URL +
        "?latitude=" + loc.latitude + "&longitude=" + loc.longitude +
        "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m" +
        "&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1";
      return request(fcUrl, { timeout: Config.WEB_TIMEOUT_MS }).then(function (fc) {
        if (!fc.ok) return fc;
        var cur = (fc.json && fc.json.current) || {};
        var daily = (fc.json && fc.json.daily) || {};
        var w = wmoDesc(cur.weather_code);
        return {
          ok: true,
          data: {
            city: displayCity,
            temp: cur.temperature_2m,
            desc: w.text,
            emoji: w.emoji,
            max: daily.temperature_2m_max && daily.temperature_2m_max[0],
            min: daily.temperature_2m_min && daily.temperature_2m_min[0],
            wind: cur.wind_speed_10m,
            humidity: cur.relative_humidity_2m
          }
        };
      });
    });
  }

  /* ================= 百科（Wikipedia REST v1） ================= */

  /**
   * 查询词条摘要。
   * @param {string} topic
   * @returns {Promise<{ok: boolean, data?: {title, extract, thumb, url}, err?: string, text?: string}>}
   */
  function wiki(topic) {
    topic = String(topic == null ? "" : topic).trim();
    if (!topic) {
      return Promise.resolve({ ok: false, err: "not-found", text: errText("not-found") });
    }
    var url = Config.WEB_WIKI_URL + "/" + encodeURIComponent(topic);
    return request(url, { timeout: Config.WEB_TIMEOUT_MS }).then(function (res) {
      if (!res.ok) return res;
      var j = res.json || {};
      if (j.type === "disambiguation") {
        return {
          ok: false,
          err: "not-found",
          text: "该词条存在多个含义（消歧义页），请尝试更具体的词条，如「云计算（技术）」"
        };
      }
      var title = j.title || topic;
      var extract = String(j.extract || "");
      var thumb = j.thumbnail && j.thumbnail.source ? j.thumbnail.source : null;
      var page = j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page
        ? j.content_urls.desktop.page : null;
      if (!extract) {
        return { ok: false, err: "not-found", text: "未找到该词条或词条内容为空，请换个词条试试" };
      }
      return { ok: true, data: { title: title, extract: extract, thumb: thumb, url: page } };
    });
  }

  /* ================= 新闻（Tavily / SerpAPI，P1 需 Key） ================= */

  function newsSerpapi(query, key) {
    var url = "https://serpapi.com/search.json?engine=google&q=" +
      encodeURIComponent(query) + "&api_key=" + encodeURIComponent(key) + "&num=5";
    return request(url, { timeout: Config.WEB_NEWS_TIMEOUT_MS }).then(function (res) {
      if (!res.ok) return res;
      var j = res.json || {};
      var list = (j.news_results || j.organic_results || []).slice(0, 5);
      return {
        ok: true,
        data: {
          items: list.map(function (it) {
            return {
              title: it.title || "",
              url: it.link || it.url || "",
              snippet: String(it.snippet || "").slice(0, 120)
            };
          })
        }
      };
    });
  }

  /**
   * 新闻搜索（默认 Tavily）。
   * @param {string} query
   * @returns {Promise<{ok: boolean, data?: {items: Array<{title, url, snippet}>}, err?: string, text?: string}>}
   */
  function news(query) {
    query = String(query == null ? "" : query).trim() || "科技";
    var key = Store.loadSearchKey();
    if (!key) {
      return Promise.resolve({ ok: false, err: "no-key", text: errText("no-key") });
    }
    var settings = Store.loadSearchSettings();
    var provider = settings.provider || "tavily";
    if (provider === "serpapi") {
      return newsSerpapi(query, key);
    }
    return request(Config.WEB_NEWS_URL + "/search", {
      method: "POST",
      timeout: Config.WEB_NEWS_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      body: { api_key: key, query: query, max_results: 5, search_depth: "basic" }
    }).then(function (res) {
      if (!res.ok) return res;
      var j = res.json || {};
      var list = (j.results || []).slice(0, 5);
      return {
        ok: true,
        data: {
          items: list.map(function (it) {
            return {
              title: it.title || "",
              url: it.url || "",
              snippet: String(it.content || it.snippet || "").slice(0, 120)
            };
          })
        }
      };
    });
  }

  window.App = window.App || {};
  window.App.AI = window.App.AI || {};
  window.App.AI.Web = {
    request: request,
    weather: weather,
    wiki: wiki,
    news: news,
    errText: errText
  };
})();
