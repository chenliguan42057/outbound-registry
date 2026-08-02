/**
 * config.js — 全局配置：产品目录 / 库存快照 / 云端仓库 / 认证常量 / POS 会话映射
 * 冻结自现网 src/index.html（commit 77bf632），记录 schema 与 localStorage 键不得随意修改。
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
    token: ""
  };

  var Config = {
    PRODUCTS: PRODUCTS,
    INVENTORY: INVENTORY,
    GH: GH,

    /* 品牌标题（Windows 桌面壳标题栏 / 顶栏 / 落地页顶栏） */
    BRAND_TITLE: "进销存管理系统",

    /* localStorage 键（冻结，不得改名） */
    STORE_KEY: "outbound_records_v2",
    GH_TOKEN_KEY: "gh_token",
    DEPT_HISTORY_KEY: "outbound_dept_history",
    PICKER_HISTORY_KEY: "outbound_picker_history",

    /* 内部状态键（经 store.js 统一管理） */
    NAV_KEY: "outbound_nav",
    DRAFT_OUT_KEY: "outbound_draft_out",
    DRAFT_IN_KEY: "outbound_draft_in",
    SEARCH_KEY: "outbound_search",

    /* AI 助手常量（第四轮增量；outbound_ai_key 仅存 localStorage，绝不入云端/CSV/记录/代码明文） */
    AI_KEY_KEY: "outbound_ai_key",
    AI_SETTINGS_KEY: "outbound_ai_settings",
    AI_CHAT_KEY: "outbound_ai_chat",
    /* 服务商列表（OpenAI 兼容接口；baseUrl 为厂商根地址，请求时拼接 /chat/completions）。
       默认服务商保持 DeepSeek，旧 settings 无 provider 字段时按 deepseek 处理（向后兼容）。 */
    AI_DEFAULT_PROVIDER: "deepseek",
    AI_PROVIDERS: [
      { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", models: ["deepseek-chat", "deepseek-reasoner"] },
      { id: "zhipu", label: "智谱 AI", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-flash", "glm-4-plus"] }
    ],
    AI_DEFAULT_MODEL: "deepseek-chat",
    AI_MODELS: ["deepseek-chat", "deepseek-reasoner"],  // 兼容旧引用（模型现由 AI_PROVIDERS 提供）
    AI_BASE_URL: "https://api.deepseek.com",            // 兼容旧引用（baseUrl 现由 AI_PROVIDERS 提供）
    AI_TIMEOUT_MS: 30000,
    AI_CHAT_HISTORY_LIMIT: 50,
    AI_CONTEXT_TOP_N: 15,
    AI_CONTEXT_RECENT: 10,
    AI_QUICK_CHIPS: ["查库存", "今日出库", "低库存", "最近出库记录", "帮我看看报表"],

    /* 认证常量（会话级内存标志，不落盘；旧 outbound_auth 残留不读取不清理） */
    PASSWORD: "1111",
    MAX_PW_FAILS: 5,                     // 连续 5 次失败
    PW_LOCK_MS: 60 * 1000,               // 锁定 60 秒

    /* POS 会话映射（P1 预留空对象：售价/条码/单位仅会话展示，绝不落库） */
    PRICE_MAP: {},
    BARCODE_MAP: {},

    /* 业务常量 */
    LOW_STOCK_THRESHOLD: 30,
    PHOTO_MAX_EDGE: 1280,
    PHOTO_QUALITY: 0.72,

    /* 令牌解析与刷新（运行时从注入/本地读取，代码中绝不出现令牌明文） */
    refreshToken: function () {
      GH.token = resolveToken();
      return GH.token;
    }
  };

  /**
   * 解析云端令牌：优先部署注入的 window.__GH_TOKEN__（占位 __GH_TOKEN_PLACEHOLDER__ 视为未注入），
   * 其次 localStorage gh_token 兜底；两者皆无 → 空串（本机模式）。
   * @returns {string}
   */
  function resolveToken() {
    return (window.__GH_TOKEN__ && window.__GH_TOKEN__.indexOf("__") !== 0)
      ? window.__GH_TOKEN__
      : (localStorage.getItem(Config.GH_TOKEN_KEY) || "");
  }

  GH.token = resolveToken();

  window.App = window.App || {};
  window.App.Config = Config;
})();
