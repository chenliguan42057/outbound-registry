/**
 * config.js — 全局配置：产品目录 / 库存快照 / 云端仓库 / 认证常量
 * 冻结自现网 src/index.html（commit 77bf632），不得随意修改。
 * 挂载到 window.App.Config。
 */
(function () {
  'use strict';

  var PRODUCTS = [
    "冻干精华液 20支装", "冻干精华液 5支装", "冻干精华液 单支装", "面膜 5片装", "面膜 1片装",
    "冻干精华液 30支装", "洁面慕斯 150ml", "洁面慕斯 50ml", "舒缓精粹水 120ml", "舒缓精粹水 30ml",
    "赋活精粹乳 80ml", "赋活精粹乳 30ml", "赋活精粹乳 1ml", "舒缓精粹霜 50g", "舒缓精粹霜 15g", "舒缓精粹霜 5g", "舒缓精粹霜 1g",
    "华大鹿茸凝时系列礼盒装",
    "小鹿牛皮纸袋（全系列护肤品手提袋）大",
    "小鹿牛皮纸袋（精华+面膜手提袋）小"
  ];

  /* 当前库存快照：以提供的剩余库存为准，已有的旧记录已包含在这些数字里。
     新增记录会带 affectsStock=true 才参与库存计算，避免旧记录重复扣减。 */
  var INVENTORY = {
    "冻干精华液 20支装": 95, "冻干精华液 5支装": 320, "冻干精华液 单支装": 222, "面膜 5片装": 139, "面膜 1片装": 218,
    "冻干精华液 30支装": 42, "洁面慕斯 150ml": 85, "洁面慕斯 50ml": 77, "舒缓精粹水 120ml": 62, "舒缓精粹水 30ml": 52,
    "赋活精粹乳 80ml": 88, "赋活精粹乳 30ml": 66, "赋活精粹乳 1ml": 124, "舒缓精粹霜 50g": 60, "舒缓精粹霜 15g": 82, "舒缓精粹霜 5g": 99, "舒缓精粹霜 1g": 127,
    "华大鹿茸凝时系列礼盒装": 4,
    "小鹿牛皮纸袋（全系列护肤品手提袋）大": 199,
    "小鹿牛皮纸袋（精华+面膜手提袋）小": 147
  };

  var GH = {
    repo: "chenliguan42057/outbound-registry",
    branch: "main",
    dir: "data/records",
    /* 云端写入令牌：由部署时从仓库密匙注入到页面（window.__GH_TOKEN__），任何设备打开即自带写入能力，
       无需在页面手动配置。localStorage 中的 gh_token 仅作为兜底。 */
    token: (window.__GH_TOKEN__ && window.__GH_TOKEN__.indexOf("__") !== 0)
      ? window.__GH_TOKEN__
      : (localStorage.getItem("gh_token") || "")
  };

  var Config = {
    PRODUCTS: PRODUCTS,
    INVENTORY: INVENTORY,
    GH: GH,

    /* localStorage 键（冻结，不得改名） */
    STORE_KEY: "outbound_records_v2",
    GH_TOKEN_KEY: "gh_token",
    DEPT_HISTORY_KEY: "outbound_dept_history",
    PICKER_HISTORY_KEY: "outbound_picker_history",

    /* 新增键（经 store.js 统一管理） */
    AUTH_KEY: "outbound_auth",
    NAV_KEY: "outbound_nav",
    DRAFT_OUT_KEY: "outbound_draft_out",
    DRAFT_IN_KEY: "outbound_draft_in",
    SEARCH_KEY: "outbound_search",

    /* 认证常量 */
    PASSWORD: "1111",
    AUTH_TTL_MS: 7 * 24 * 3600 * 1000,   // 记住登录 7 天
    MAX_PW_FAILS: 5,                     // 连续 5 次失败
    PW_LOCK_MS: 60 * 1000,               // 锁定 60 秒

    /* 业务常量 */
    LOW_STOCK_THRESHOLD: 30,
    PHOTO_MAX_EDGE: 1280,
    PHOTO_QUALITY: 0.72
  };

  window.App = window.App || {};
  window.App.Config = Config;
})();
