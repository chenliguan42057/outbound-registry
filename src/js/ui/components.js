/**
 * components.js — 可复用 UI 组件
 * SVG 图标 / Modal / Confirm 弹窗 / 登录弹窗 / CollapseSection / ProductPicker / PhotoUpload
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;
  var Auth = window.App.Auth;
  var $ = Util.$;

  /* ================= SVG 图标 ================= */
  var ICON_PATHS = {
    out: '<path d="M3 4h4v16H3zM10 4h11v2H10zM10 9h8v2h-8zM10 14h11v2H10zM10 19h6v2h-6z"/>',
    in: '<path d="M12 3v10m0 0l-4-4m4 4l4-4M4 19h16"/>',
    stock: '<path d="M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4m0 0l8-4m-8 4v10"/>',
    records: '<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6"/>',
    report: '<path d="M4 20V10m6 10V4m6 16v-8m4 8H2"/>',
    sync: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5m0 0l9-5m-9 5v8"/>',
    swap: '<path d="M7 20V4m0 0L4 7m3-3l3 3M17 4v16m0 0l3-3m-3 3l-3-3"/>',
    photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 15l-5-5-9 9"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>',
    download: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'
  };

  /** 生成 SVG 图标字符串 */
  function icon(name, size) {
    size = size || 18;
    return '<svg class="app-icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      (ICON_PATHS[name] || ICON_PATHS.box) + '</svg>';
  }

  /* ================= Modal ================= */
  var modalEl = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    var root = $("modal-root");
    if (!root) return null;
    modalEl = document.createElement("div");
    modalEl.className = "modal";
    modalEl.innerHTML =
      '<div class="modal-card">' +
        '<button type="button" class="modal-close" data-act="close" aria-label="关闭">&times;</button>' +
        '<div class="modal-title"></div>' +
        '<div class="modal-body"></div>' +
      '</div>';
    modalEl.addEventListener("click", function (e) {
      if (e.target === modalEl || (e.target.getAttribute && e.target.getAttribute("data-act") === "close")) {
        Modal.hide();
        return;
      }
      // 弹窗内照片点击放大（data-act="photo"）
      var img = e.target.closest ? e.target.closest("[data-act=photo]") : null;
      if (img) {
        var src = img.getAttribute("src") || img.getAttribute("data-src");
        if (src) {
          Modal.show("照片预览", '<img class="preview-img" src="' + Util.esc(Util.safeUrl(src)) + '" alt="" />', { width: "fit-content" });
        }
      }
    });
    root.appendChild(modalEl);
    return modalEl;
  }

  var Modal = {
    /** 显示弹窗：bodyHtml 可为 HTML 字符串或 DOM 元素 */
    show: function (title, bodyHtml, opts) {
      opts = opts || {};
      var el = ensureModal();
      if (!el) return;
      el.querySelector(".modal-title").textContent = title || "";
      var body = el.querySelector(".modal-body");
      body.innerHTML = "";
      if (typeof bodyHtml === "string") body.innerHTML = bodyHtml;
      else if (bodyHtml && bodyHtml.nodeType) body.appendChild(bodyHtml);
      if (opts.width) el.querySelector(".modal-card").style.width = opts.width;
      el.classList.add("show");
      document.body.classList.add("modal-open");
    },
    hide: function () {
      if (!modalEl) return;
      modalEl.classList.remove("show");
      document.body.classList.remove("modal-open");
    },
    body: function () {
      var el = ensureModal();
      return el ? el.querySelector(".modal-body") : null;
    }
  };

  /** 确认弹窗：Promise<boolean>
      修复（2026-09-05）：原版 .onclick = function(){...} 赋值存在两个隐患——
        1) querySelector('[data-act="ok"]') 若返回 null 时会 null.onclick 抛错，promise 永不 resolve
           （用户感知为"确认按钮点不动"），常见于 mBody 上已堆叠 click 监听把按钮吞掉的场景；
        2) .onclick 直接赋值在动态插入的 button 上偶有边界问题。
      改为 addEventListener + null 守卫 + 包裹 close() 函数（异常吞掉 Modal.hide 抛错，保证 resolve 必触发）；
      并默认 focus 到 OK 按钮，移动端/键盘 Enter 也能直接确认。 */
  function confirmDialog(msg, title) {
    return new Promise(function (resolve) {
      var body =
        '<div class="confirm-msg">' + Util.esc(msg) + '</div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
          '<button type="button" class="btn sm" data-act="ok">确认</button>' +
        '</div>';
      Modal.show(title || "请确认", body, { width: "340px" });
      var mBody = Modal.body();
      var okBtn = mBody && mBody.querySelector('[data-act="ok"]');
      var noBtn = mBody && mBody.querySelector('[data-act="cancel"]');
      function close(v) {
        try { Modal.hide(); } catch (e) {}
        resolve(v);
      }
      if (okBtn) okBtn.addEventListener('click', function () { close(true); });
      if (noBtn) noBtn.addEventListener('click', function () { close(false); });
      // 默认聚焦 OK：键盘 Enter 直接确认，移动端软键盘也走 OK
      try { setTimeout(function () { if (okBtn && document.contains(okBtn)) okBtn.focus(); }, 60); } catch (e) {}
    });
  }

  /** 提交前「核对清单」弹窗（2026-09-24）→ Promise<boolean>。
      四个登记视图（出库 / 入库 / 待取货 / 调拨）共用，确保「确认后才写库」的口径一致。
      data: {
        title   弹窗标题（默认「确认提交这单？」）
        okText  确认按钮文案（默认「确认提交」）
        meta    [[标签, 值], ...] 关键字段区
        items   [{name, qty}] 货品明细（自动算「N 项 · 共 X 件」）
        extras  [html] 追加说明块（调用方自行包 class）
      }
      注意：本函数不做 HTML 转义的是 extras（由调用方构造），meta/items 全部走 Util.esc。 */
  function confirmSubmit(data) {
    data = data || {};
    var items = data.items || [];
    var total = 0;
    items.forEach(function (it) { total += Math.abs(Number(it.qty) || 0); });
    return new Promise(function (resolve) {
      var metaHtml = (data.meta || []).map(function (r) {
        return '<div class="cf-meta-row"><span class="cf-k">' + Util.esc(r[0]) + '</span><span class="cf-v">' + Util.esc(r[1]) + '</span></div>';
      }).join("");
      var listHtml = items.map(function (it) {
        return '<div class="cf-line"><span class="cf-line-name">' + Util.esc(it.name) +
          '</span><span class="cf-line-qty">×' + Util.esc(it.qty) + '</span></div>';
      }).join("");
      var body =
        '<div class="cf-wrap">' +
          (metaHtml ? '<div class="cf-meta">' + metaHtml + '</div>' : "") +
          (items.length
            ? '<div class="cf-items-title">货品（' + items.length + ' 项 · 共 ' + total + ' 件）</div>' +
              '<div class="cf-list">' + listHtml + '</div>'
            : "") +
          (data.extras || []).join("") +
          '<div class="modal-actions">' +
            '<button type="button" class="btn ghost sm" data-act="cancel">返回修改</button>' +
            '<button type="button" class="btn sm" data-act="ok">' + Util.esc(data.okText || "确认提交") + '</button>' +
          '</div>' +
        '</div>';
      Modal.show(data.title || "确认提交这单？", body, { width: data.width || "92vw" });
      var mBody = Modal.body();
      function close(v) {
        try { Modal.hide(); } catch (e) {}
        resolve(v);
      }
      var okBtn = mBody && mBody.querySelector('[data-act="ok"]');
      var noBtn = mBody && mBody.querySelector('[data-act="cancel"]');
      if (okBtn) okBtn.addEventListener("click", function () { close(true); });
      if (noBtn) noBtn.addEventListener("click", function () { close(false); });
      try { setTimeout(function () { if (okBtn && document.contains(okBtn)) okBtn.focus(); }, 60); } catch (e) {}
    });
  }

  /** 带输入框的必填弹窗：Promise<{ok:boolean, value:string}>；输入为空点确认不关闭并提示 */
  function promptDialog(msg, placeholder, title, okText) {
    return new Promise(function (resolve) {
      var body =
        '<div class="confirm-msg">' + Util.esc(msg || "") + '</div>' +
        '<input type="text" class="pw-input" id="promptInput" placeholder="' + Util.esc(placeholder || "") + '" autocomplete="off" />' +
        '<div class="pw-err" id="promptErr"></div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
          '<button type="button" class="btn sm" data-act="ok">' + Util.esc(okText || "确定") + '</button>' +
        '</div>';
      Modal.show(title || "请输入", body, { width: "340px" });
      var mBody = Modal.body();
      var input = mBody.querySelector("#promptInput");
      var errEl = mBody.querySelector("#promptErr");
      function ok() {
        var val = input.value.trim();
        if (!val) { errEl.textContent = "此项为必填，不能为空"; input.focus(); return; }
        Modal.hide();
        resolve({ ok: true, value: val });
      }
      mBody.querySelector('[data-act="ok"]').onclick = ok;
      mBody.querySelector('[data-act="cancel"]').onclick = function () { Modal.hide(); resolve({ ok: false, value: "" }); };
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") ok(); });
      setTimeout(function () { input.focus(); }, 50);
    });
  }

  /** 登录弹窗（路由守卫 / 落地页管理入口）：Promise<boolean>，成功返回 true */
  function showLoginDialog() {
    return new Promise(function (resolve) {
      var body =
        '<div class="login-dialog">' +
          '<div class="login-lock">' + icon("lock", 26) + '</div>' +
          '<p class="login-sub">请输入访问密码进入管理</p>' +
          '<input type="password" class="pw-input" id="loginPw" placeholder="请输入密码" autocomplete="off" />' +
          '<div class="pw-err" id="loginErr"></div>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
            '<button type="button" class="btn sm" data-act="ok">进入</button>' +
          '</div>' +
        '</div>';
      Modal.show("登录", body, { width: "320px" });
      var mBody = Modal.body();
      var input = mBody.querySelector("#loginPw");
      var errEl = mBody.querySelector("#loginErr");
      function ok() {
        var remain = Auth.remainingLock();
        if (remain > 0) {
          errEl.textContent = "尝试次数过多，请 " + Math.ceil(remain / 1000) + " 秒后再试";
          input.select();
          return;
        }
        var res = Auth.login(input.value);
        if (res.ok) { Modal.hide(); resolve(true); }
        else { errEl.textContent = res.err || "密码错误，请重试"; input.select(); }
      }
      mBody.querySelector('[data-act="ok"]').onclick = ok;
      mBody.querySelector('[data-act="cancel"]').onclick = function () { Modal.hide(); resolve(false); };
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") ok(); });
      setTimeout(function () { input.focus(); }, 50);
    });
  }

  /* ================= CollapseSection ================= */
  /** 折叠区块 HTML；bindCollapse(container) 绑定开关 */
  function collapseSection(title, bodyHtml, open, extraClass) {
    return '<div class="collapse ' + (extraClass || "") + '">' +
      '<div class="collapse-head' + (open ? " open" : "") + '" role="button" tabindex="0">' +
        '<span class="collapse-title">' + title + '</span>' +
        '<span class="collapse-arrow">' + icon("chevron", 16) + '</span>' +
      '</div>' +
      '<div class="collapse-body"' + (open ? "" : ' style="display:none"') + '>' + bodyHtml + '</div>' +
    '</div>';
  }

  function bindCollapse(container) {
    if (!container) return;
    var heads = container.querySelectorAll(".collapse-head");
    for (var i = 0; i < heads.length; i++) {
      var head = heads[i];
      if (head.getAttribute("data-bound")) continue;
      head.setAttribute("data-bound", "1");
      head.addEventListener("click", function () {
        var body = this.nextElementSibling;
        var isOpen = body.style.display !== "none";
        body.style.display = isOpen ? "none" : "";
        this.classList.toggle("open", !isOpen);
      });
    }
  }

  /* ================= ProductPicker ================= */
  /**
   * 货品多选 + 搜索 + 数量 + 库存显示
   * opts: { showStock, showInStock, placeholder, onChange }
   */
  function ProductPicker(opts) {
    opts = opts || {};
    this.selected = [];               // [{name, qty}]
    this.showStock = opts.showStock !== false;
    this.showInStock = !!opts.showInStock;
    this.placeholder = opts.placeholder || "搜索并选择货品（可多选，每个单独填数量）";
    this.onChange = opts.onChange || null;
    this.container = null;
    this.searchEl = null;
    this.suggestEl = null;
    this.listEl = null;
    this.hintEl = null;
    this.activeIndex = -1;            // 候选列表键盘高亮下标（-1 表示无）
    this.bulkPick = !!opts.bulkPick;  // 2026-09-24：分类多选 → 统一填数量（落地页/出库启用）
    this.panel = null;                // bulkPick 全屏选择面板 DOM
    this.step = 1;                    // 面板步骤：1=按分类选品，2=统一填数量
    this.draft = [];                  // 面板暂存 [{name, qty}]（未点「完成」前不改动 selected）
    this.panelQ = "";                 // 面板内搜索词（保留原大小写）
  }

  ProductPicker.prototype.attach = function (container) {
    var self = this;
    this.container = container;
    // 2026-09-24 分类多选模式走独立分支，其余视图（入库/待取货/调拨）行为完全不变
    if (this.bulkPick) { this.attachBulk(container); return; }
    container.innerHTML =
      '<div class="search-wrap">' +
        '<input type="text" class="search" placeholder="' + Util.esc(this.placeholder) + '" autocomplete="off" inputmode="search" enterkeyhint="search" role="combobox" aria-expanded="false" aria-autocomplete="list" />' +
        '<div class="suggest"></div>' +
      '</div>' +
      '<div class="selected"></div>' +
      '<div class="hint"></div>';
    this.searchEl = container.querySelector(".search");
    this.suggestEl = container.querySelector(".suggest");
    this.listEl = container.querySelector(".selected");
    this.hintEl = container.querySelector(".hint");

    this.searchEl.addEventListener("input", function () { self.renderSuggest(); });
    this.searchEl.addEventListener("focus", function () { self.renderSuggest(); });
    // 键盘 / 扫码枪：↑↓ 移动候选，Enter 选中当前候选（扫码枪打完条码发 Enter 的语义是
    // 「选中这件货品」而不是「提交整单」），Esc 收起候选列表。
    this.searchEl.addEventListener("keydown", function (e) {
      var key = e.key;
      if (key === "Escape") { self.suggestEl.style.display = "none"; self.activeIndex = -1; return; }
      var open = self.suggestEl.style.display !== "none";
      var opts = self.suggestEl.children;
      if (key === "ArrowDown" || key === "ArrowUp") {
        if (!open) { self.renderSuggest(); opts = self.suggestEl.children; }
        if (!opts.length) return;
        e.preventDefault();
        var dir = key === "ArrowDown" ? 1 : -1;
        var n = opts.length;
        self.activeIndex = ((self.activeIndex < 0 ? (dir > 0 ? -1 : 0) : self.activeIndex) + dir + n) % n;
        self.highlightSuggest();
        return;
      }
      if (key === "Enter") {
        // 候选列表打开时一律拦截 Enter，避免冒泡到表单层触发其他行为
        if (open && opts.length) {
          e.preventDefault();
          e.stopPropagation();
          var idx = self.activeIndex >= 0 ? self.activeIndex : 0;
          var pick = opts[idx] && opts[idx].getAttribute("data-name");
          if (pick) self.addProduct(pick);
        }
      }
    });
    // 「点击空白处收起候选」必须挂在 document 上。但每次切换视图都会 new 一个 ProductPicker，
    // 旧监听不摘就会无限叠加，并让已卸载的 DOM 无法回收。这里做两件事：
    //   ① 同一实例重复 attach 时先摘旧的；② 监听自身检测容器已卸载 → 自我摘除。
    if (this._docClick) document.removeEventListener("click", this._docClick);
    this._docClick = function (e) {
      if (!self.container || !self.container.isConnected) {
        document.removeEventListener("click", self._docClick);
        return;
      }
      if (!e.target.closest(".search-wrap")) self.suggestEl.style.display = "none";
    };
    document.addEventListener("click", this._docClick);
    this.listEl.addEventListener("click", function (e) {
      var x = e.target.closest(".x");
      if (x) {
        self.selected.splice(Number(x.getAttribute("data-i")), 1);
        self.render();
        self.emit();
        return;
      }
      var qb = e.target.closest(".qty-btn");
      if (qb) {
        var i = Number(qb.getAttribute("data-i"));
        var cur = Number(self.selected[i].qty) || 0;
        var next = qb.getAttribute("data-act") === "inc" ? cur + 1 : cur - 1;   // 2026-09-08 允许负数（冲正/库存可为负），不再钳 0
        self.selected[i].qty = next;
        self.render();
        self.emit();
      }
    });
    this.listEl.addEventListener("input", function (e) {
      var inp = e.target.closest(".qty");
      if (inp) {
        self.selected[Number(inp.getAttribute("data-i"))].qty = inp.value;
        self.emit();
      }
    });
    // 数量取整（2026-09-05）：货品按支/盒/袋计，只允许正整数。
    // blur/change 时若填了小数（如 2.5）自动就近取整并轻提示，避免小数库存进入流水。
    this.listEl.addEventListener("change", function (e) {
      var inp = e.target.closest(".qty");
      if (!inp) return;
      var i = Number(inp.getAttribute("data-i"));
      var raw = String(inp.value || "").trim();
      if (raw === "") return;
      var v = Number(raw);
      if (!isFinite(v)) return;
      var r = Math.round(v);
      if (r === v) { self.selected[i].qty = v; return; }
      self.selected[i].qty = r;
      inp.value = String(r);
      self.emit();
      var nm = self.selected[i] ? self.selected[i].name : "";
      if (window.App && window.App.Util && window.App.Util.toast) {
        window.App.Util.toast("「" + (nm || "货品") + "」数量已按整数取整为 " + r);
      }
    });
    this.render();
  };

  /* ================= ProductPicker · bulkPick 模式（2026-09-24） ================= */
  /**
   * 落地页/出库「按产品名分类多选 → 最后统一步填数量」。
   * 与默认模式共用 selected / getItems / validateItems / setSelected / emit，对外 API 完全不变，
   * 因此入库、待取货、调拨等视图无需改动（不传 bulkPick 即维持原交互）。
   * 分类规则：按产品名里的系列关键词归组（与金山子表归属同一套词），保证同系列规格聚在一起。
   */
  var PICK_GROUP_ORDER = ["精华液", "精粹水", "精粹乳", "精粹霜", "面膜", "洁面慕斯",
    "小鹿牛皮纸袋", "员工帆布袋", "礼盒", "拎袋"];

  function pickGroupOf(name) {
    var n = String(name || "");
    for (var i = 0; i < PICK_GROUP_ORDER.length; i++) {
      if (n.indexOf(PICK_GROUP_ORDER[i]) !== -1) return PICK_GROUP_ORDER[i];
    }
    return n.split(" ")[0] || "其他";
  }

  /** 分类色号（0-9，对应 picker.css 里的 --bpa/--bpb/--bpl 三色套件）。
      用「分类在 PICK_GROUP_ORDER 里的固定下标」而非渲染下标 —— 搜索过滤后组数会变，
      用渲染下标会导致同一个分类换色，视觉上乱跳。未识别分类统一落到 9 号色。 */
  function pickGroupColorIndex(groupName) {
    var i = PICK_GROUP_ORDER.indexOf(groupName);
    return i < 0 ? 9 : i;
  }

  /** 表单区：入口（外观做成「输入框」而非按钮，避免被误认成提交按钮）+ 已选清单 */
  ProductPicker.prototype.attachBulk = function (container) {
    var self = this;
    container.innerHTML =
      '<div class="bp-cta">' +
        '<button type="button" class="bp-open is-empty">' +
          '<span class="bp-open-icon">＋</span>' +
          '<span class="bp-open-text">点击选择货品（可多选）</span>' +
          '<span class="bp-open-arrow">›</span>' +
        '</button>' +
      '</div>' +
      '<div class="bp-selbar" style="display:none">' +
        '<span class="bp-selbar-title"></span>' +
        '<button type="button" class="bp-adjust">调整数量</button>' +
      '</div>' +
      '<div class="selected"></div>';
    this.listEl = container.querySelector(".selected");
    this.openBtnEl = container.querySelector(".bp-open");
    this.openTextEl = container.querySelector(".bp-open-text");
    this.selbarEl = container.querySelector(".bp-selbar");
    this.selbarTitleEl = container.querySelector(".bp-selbar-title");
    this.openBtnEl.addEventListener("click", function () { self.openPanel(1); });
    container.querySelector(".bp-adjust").addEventListener("click", function () {
      self.openPanel(self.selected.length ? 2 : 1);
    });
    this.listEl.addEventListener("click", function (e) {
      var x = e.target.closest(".bp-sel-x");
      if (!x) return;
      self.selected.splice(Number(x.getAttribute("data-i")), 1);
      self.render();
      self.emit();
    });
    this.render();
  };

  /** 按分类分组（q 为空返回全部）；组顺序固定，未识别组排最后 */
  ProductPicker.prototype.buildGroups = function (q) {
    var map = {}, order = [];
    var key = String(q || "").toLowerCase();
    (Config.PRODUCTS || []).forEach(function (p) {
      if (key && String(p).toLowerCase().indexOf(key) === -1) return;
      var g = pickGroupOf(p);
      if (!map[g]) { map[g] = []; order.push(g); }
      map[g].push(p);
    });
    order.sort(function (a, b) {
      var ia = PICK_GROUP_ORDER.indexOf(a); if (ia < 0) ia = 999;
      var ib = PICK_GROUP_ORDER.indexOf(b); if (ib < 0) ib = 999;
      return ia - ib;
    });
    return order.map(function (g) { return { name: g, items: map[g] }; });
  };

  /** 打开全屏面板：step=1 按分类选品，step=2 统一填数量 */
  ProductPicker.prototype.openPanel = function (step) {
    var self = this;
    if (this.panel) this.closePanel();
    this.draft = this.selected.map(function (s) { return { name: s.name, qty: s.qty }; });
    this.step = step === 2 ? 2 : 1;
    this.panelQ = "";
    if (this.step === 2 && !this.draft.length) this.step = 1;

    var el = document.createElement("div");
    el.className = "bp-mask";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "选择货品");
    el.innerHTML =
      '<div class="bp-panel">' +
        '<div class="bp-head">' +
          '<button type="button" class="bp-back" aria-label="返回">‹</button>' +
          '<span class="bp-title">选择货品</span>' +
          '<button type="button" class="bp-close" aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="bp-body"></div>' +
        '<div class="bp-foot"></div>' +
      '</div>';

    // 面板内交互统一委托到根节点：切换步骤、重建 DOM 都不会丢事件
    el.addEventListener("click", function (e) {
      if (e.target === el) { self.closePanel(); return; }          // 点遮罩空白关闭
      var t = e.target;
      if (t.closest(".bp-close")) { self.closePanel(); return; }
      if (t.closest(".bp-back")) { self.step = 1; self.renderPanel(); return; }
      if (t.closest(".bp-next")) { self.gotoStep2(); return; }
      if (t.closest(".bp-done")) { self.commitPanel(); return; }
      var qb = t.closest(".bp-qb");
      if (qb) {
        var qi = Number(qb.getAttribute("data-i"));
        var cur = Number(self.draft[qi].qty) || 0;
        self.draft[qi].qty = qb.getAttribute("data-act") === "inc" ? cur + 1 : cur - 1;
        self.renderPanel();
        return;
      }
      var rx = t.closest(".bp-rx");
      if (rx) {
        self.draft.splice(Number(rx.getAttribute("data-i")), 1);
        self.renderPanel();
        return;
      }
      var item = t.closest(".bp-item");
      if (item) self.toggleDraft(item.getAttribute("data-name"));
    });
    el.addEventListener("input", function (e) {
      var box = e.target.closest(".bp-search");
      if (box) { self.panelQ = box.value; self.renderGroups(); return; }   // 只重绘分组，保住输入焦点
      var num = e.target.closest(".bp-q");
      if (num) self.draft[Number(num.getAttribute("data-i"))].qty = num.value;
    });
    // 数量取整：与表单内口径一致（支/盒/袋按整件计）
    el.addEventListener("change", function (e) {
      var num = e.target.closest(".bp-q");
      if (!num) return;
      var i = Number(num.getAttribute("data-i"));
      var raw = String(num.value || "").trim();
      if (raw === "") return;
      var v = Number(raw);
      if (!isFinite(v)) return;
      var r = Math.round(v);
      self.draft[i].qty = r;
      num.value = String(r);
    });

    document.body.appendChild(el);
    document.body.classList.add("bp-lock");
    this.panel = el;
    this.renderPanel();
  };

  ProductPicker.prototype.closePanel = function () {
    if (this.panel && this.panel.parentNode) this.panel.parentNode.removeChild(this.panel);
    this.panel = null;
    if (document.body) document.body.classList.remove("bp-lock");
  };

  ProductPicker.prototype.renderPanel = function () {
    if (!this.panel) return;
    var body = this.panel.querySelector(".bp-body");
    var foot = this.panel.querySelector(".bp-foot");
    var title = this.panel.querySelector(".bp-title");

    if (this.step === 2) {
      title.textContent = "填写数量";
      body.innerHTML = '<div class="bp-tip">已选 ' + this.draft.length + ' 项，逐项确认数量后点「完成」。</div>' +
        this.draft.map(function (it, i) {
          return '<div class="bp-row" data-c="' + pickGroupColorIndex(pickGroupOf(it.name)) + '">' +
              '<div class="bp-row-head">' +
                '<span class="bp-row-name">' + Util.esc(it.name) + '</span>' +
                '<span class="bp-rx" data-i="' + i + '" role="button" aria-label="移除">✕</span>' +
              '</div>' +
              '<div class="bp-step">' +
                '<button type="button" class="bp-qb" data-act="dec" data-i="' + i + '" aria-label="减少">−</button>' +
                '<input type="number" step="1" inputmode="numeric" enterkeyhint="done" class="bp-q" data-i="' + i + '" value="' + Util.esc(it.qty) + '" aria-label="' + Util.esc(it.name) + ' 数量" />' +
                '<button type="button" class="bp-qb" data-act="inc" data-i="' + i + '" aria-label="增加">＋</button>' +
              '</div>' +
            '</div>';
        }).join("");
      var totalQty = 0;
      this.draft.forEach(function (d) { totalQty += Math.abs(Number(d.qty) || 0); });
      foot.innerHTML =
        '<button type="button" class="bp-ghost">‹ 继续加货</button>' +
        '<button type="button" class="bp-done">完成（' + this.draft.length + ' 项 · 共 ' + totalQty + ' 件）</button>';
      return;
    }

    title.textContent = "选择货品";
    body.innerHTML =
      '<input type="search" class="bp-search" placeholder="搜索货品名称…" autocomplete="off" enterkeyhint="search" value="' + Util.esc(this.panelQ) + '" />' +
      '<div class="bp-groups"></div>';
    this.renderGroups();
  };

  /** 只重绘分类网格 + 底部按钮（搜索时调用，避免重建输入框丢焦点） */
  ProductPicker.prototype.renderGroups = function () {
    if (!this.panel) return;
    var self = this;
    var box = this.panel.querySelector(".bp-groups");
    if (!box) return;
    var groups = this.buildGroups(this.panelQ);
    var total = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    if (!total) {
      box.innerHTML = '<div class="bp-empty">没有匹配的货品</div>';
    } else {
      box.innerHTML = groups.map(function (g) {
        return '<div class="bp-group" data-c="' + pickGroupColorIndex(g.name) + '">' +
            '<h4>' + Util.esc(g.name) + '<span class="bp-gcount">' + g.items.length + '</span></h4>' +
            '<div class="bp-grid">' +
              g.items.map(function (p) {
                var on = self.draft.some(function (d) { return d.name === p; });
                return '<button type="button" class="bp-item' + (on ? " on" : "") + '" data-name="' + Util.esc(p) + '" aria-pressed="' + (on ? "true" : "false") + '">' + Util.esc(p) + '</button>';
              }).join("") +
            '</div>' +
          '</div>';
      }).join("");
    }
    this.renderFoot();
  };

  ProductPicker.prototype.renderFoot = function () {
    if (!this.panel || this.step === 2) return;
    var foot = this.panel.querySelector(".bp-foot");
    if (!foot) return;
    var n = this.draft.length;
    foot.innerHTML = n
      ? '<button type="button" class="bp-next">下一步 · 填数量（' + n + '）</button>'
      : '<button type="button" class="bp-next" disabled>请先选择货品</button>';
  };

  /** 勾选/取消勾选：只切换相关项样式 + 刷新底部计数，不整块重绘（手机上更跟手） */
  ProductPicker.prototype.toggleDraft = function (name) {
    if (!name) return;
    var self = this;
    var idx = -1;
    this.draft.forEach(function (d, i) { if (d.name === name) idx = i; });
    if (idx >= 0) this.draft.splice(idx, 1);
    else this.draft.push({ name: name, qty: 1 });       // 数量默认 1，第二步统一调整
    var items = this.panel ? this.panel.querySelectorAll(".bp-item") : [];
    Array.prototype.forEach.call(items, function (b) {
      var on = self.draft.some(function (d) { return d.name === b.getAttribute("data-name"); });
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    this.renderFoot();
  };

  ProductPicker.prototype.gotoStep2 = function () {
    if (!this.draft.length) return;
    this.step = 2;
    this.renderPanel();
  };

  /** 第二步「完成」：校验全部数量 → 写回 selected 并通知表单 */
  ProductPicker.prototype.commitPanel = function () {
    var problems = [];
    this.draft.forEach(function (d) {
      var n = d.qty === "" ? 0 : Number(d.qty);
      if (!isFinite(n) || n === 0) problems.push(d.name);
      else if (Math.floor(n) !== n) problems.push(d.name + "（需整数）");
    });
    if (problems.length) {
      Util.toast("请填写数量：" + problems.join("、"), true);
      return;
    }
    this.selected = this.draft.map(function (d) { return { name: d.name, qty: Number(d.qty) }; });
    this.closePanel();
    this.render();
    this.emit();
  };

  ProductPicker.prototype.renderSuggest = function () {
    var self = this;
    var q = this.searchEl.value.trim().toLowerCase();
    var pool = Config.PRODUCTS.filter(function (p) {
      return !self.selected.some(function (s) { return s.name === p; }) &&
        (q === "" || p.toLowerCase().includes(q));
    });
    this.suggestEl.innerHTML = "";
    if (!pool.length) {
      this.suggestEl.style.display = "none";
      this.activeIndex = -1;
      this.searchEl.setAttribute("aria-expanded", "false");
      return;
    }
    pool.slice(0, 30).forEach(function (p) {
      var d = document.createElement("div");
      d.textContent = p;
      d.setAttribute("data-name", p);
      d.setAttribute("role", "option");
      d.addEventListener("mousedown", function (ev) { ev.preventDefault(); self.addProduct(p); });
      self.suggestEl.appendChild(d);
    });
    this.suggestEl.style.display = "block";
    this.searchEl.setAttribute("aria-expanded", "true");
    // 精确匹配时预选中，扫码枪扫出完整条码/货品名后直接 Enter 即可入选
    this.activeIndex = -1;
    if (q) {
      for (var i = 0; i < this.suggestEl.children.length; i++) {
        if (this.suggestEl.children[i].getAttribute("data-name").toLowerCase() === q) { this.activeIndex = i; break; }
      }
      if (this.activeIndex < 0) this.activeIndex = 0;
    }
    this.highlightSuggest();
  };

  /** 同步候选项高亮态到 this.activeIndex */
  ProductPicker.prototype.highlightSuggest = function () {
    var opts = this.suggestEl.children;
    for (var i = 0; i < opts.length; i++) {
      var on = i === this.activeIndex;
      opts[i].classList.toggle("active", on);
      opts[i].setAttribute("aria-selected", on ? "true" : "false");
      if (on && opts[i].scrollIntoView) opts[i].scrollIntoView({ block: "nearest" });
    }
  };

  ProductPicker.prototype.addProduct = function (name) {
    if (this.selected.some(function (s) { return s.name === name; })) return;
    // 新选的货品插到最前面，最后选的永远在第一位显示
    this.selected.unshift({ name: name, qty: 1 });
    this.searchEl.value = "";
    this.suggestEl.style.display = "none";
    this.render();
    this.emit();
  };

  ProductPicker.prototype.render = function () {
    var self = this;
    this.listEl.innerHTML = "";
    if (this.bulkPick) {
      // 已选清单：数量只读 + 单项移除（改数量统一走面板第二步，避免边选边填）
      this.selected.forEach(function (it, i) {
        var row = document.createElement("div");
        row.className = "bp-sel";
        row.innerHTML =
          '<span class="bp-sel-name">' + Util.esc(it.name) + '</span>' +
          '<span class="bp-sel-qty">×' + Util.esc(it.qty) + '</span>' +
          '<span class="bp-sel-x" data-i="' + i + '" role="button" aria-label="移除">✕</span>';
        self.listEl.appendChild(row);
      });
      var n = this.selected.length;
      // 入口区随「有没有选」切换文案与视觉：空 = 虚线待填框，有 = 实线 + 已选条
      if (this.openBtnEl) {
        this.openBtnEl.classList.toggle("is-empty", !n);
        if (this.openTextEl) this.openTextEl.textContent = n ? "继续添加货品" : "点击选择货品（可多选）";
      }
      if (this.selbarEl) {
        this.selbarEl.style.display = n ? "" : "none";
        if (this.selbarTitleEl) this.selbarTitleEl.textContent = "已选 " + n + " 项";
      }
      // 提示文案改由字段标签旁的橙色胶囊承担（主理人 2026-09-24 要求去掉此处的灰色小字）
      return;
    }
    this.selected.forEach(function (it, i) {
      var row = document.createElement("div");
      row.className = "sel-item";
      // 库存展示已隐藏，避免挤占货品名称完整显示空间
      row.innerHTML =
        '<span class="name">' + Util.esc(it.name) + '</span>' +
        '<div class="qty-stepper">' +
          '<button type="button" class="qty-btn" data-act="dec" data-i="' + i + '" aria-label="减少">−</button>' +
          '<input type="number" min="-999999" max="999999" step="1" inputmode="numeric" enterkeyhint="done" aria-label="' + Util.esc(it.name) + ' 数量" value="' + Util.esc(it.qty) + '" class="qty" data-i="' + i + '" />' +
          '<button type="button" class="qty-btn" data-act="inc" data-i="' + i + '" aria-label="增加">+</button>' +
        '</div>' +
        '<span class="x" data-i="' + i + '">&times;</span>';
      self.listEl.appendChild(row);
    });
    this.hintEl.textContent = this.selected.length
      ? "已选 " + this.selected.length + " 项货品，请逐项确认数量。"
      : "尚未选择货品，请在上方搜索并选择。";
  };

  /** 获取有效货品 [{name, qty}]（2026-09-08 允许负数登记：|qty| 落在 [MIN_QTY, MAX_QTY] 且 ≠0；
      0 视为未填被过滤；0.0001 这类误填仍按 |qty| < MIN_QTY 丢弃） */
  ProductPicker.MIN_QTY = 0.001;
  ProductPicker.MAX_QTY = 999999;
  ProductPicker.prototype.getItems = function () {
    return this.selected
      .map(function (s) { return { name: s.name, qty: s.qty === "" ? 0 : Number(s.qty) }; })
      .filter(function (s) {
        var q = s.qty;
        return s.name && isFinite(q) && q !== 0
          && Math.abs(q) >= ProductPicker.MIN_QTY && Math.abs(q) <= ProductPicker.MAX_QTY;
      });
  };

  /** 校验已选货品的数量填写情况，返回问题描述数组（供表单做字段级提示）
      2026-09-25 加固：增加「同一货品重复出现」拦截。
      背景：同一次提交里同一货品出现两行时，两行会各自扣减库存、各自出现在明细与台账里，
      人工核对极易看漏（看起来只领了一次）。数量应合并为一行填写。 */
  ProductPicker.prototype.validateItems = function () {
    var problems = [];
    var seen = {};
    this.selected.forEach(function (s, i) {
      var key = String(s.name || "").trim();
      if (key && Object.prototype.hasOwnProperty.call(seen, key)) {
        if (seen[key] === -1) {
          problems.push(key + " 重复出现，请合并为一行填写数量");
          seen[key] = -2;   // 只报一次，避免三条以上重复时重复刷屏
        }
      } else if (key) {
        seen[key] = i;
      }
      var n = s.qty === "" ? 0 : Number(s.qty);
      if (!isFinite(n) || n === 0) problems.push(s.name + " 未填数量");
      else if (Math.floor(n) !== n) problems.push(s.name + " 数量需为整数（支/盒/袋按整件计）");
      else if (Math.abs(n) < ProductPicker.MIN_QTY) problems.push(s.name + " 数量过小");
      else if (Math.abs(n) > ProductPicker.MAX_QTY) problems.push(s.name + " 数量超上限");
    });
    return problems;
  };

  ProductPicker.prototype.setSelected = function (arr) {
    this.selected = (arr || []).map(function (it) { return { name: it.name, qty: it.qty }; });
    this.render();
  };

  ProductPicker.prototype.emit = function () {
    if (this.onChange) this.onChange(this.getItems(), this.selected);
  };

  /** 显式销毁：摘掉挂在 document 上的全局监听。视图切换时可主动调用（不调也会自我摘除） */
  ProductPicker.prototype.destroy = function () {
    this.closePanel();   // 视图切换时若面板还开着，一并摘掉，避免遮罩残留在 body 上
    if (this._docClick) {
      document.removeEventListener("click", this._docClick);
      this._docClick = null;
    }
    this.container = null;
  };

  /* ================= PhotoUpload ================= */
  /**
   * 照片上传：点击/拖拽 → 压缩为 JPEG dataURL（max 1280px / quality 0.72）
   * opts: { onChange }
   */
  function PhotoUpload(opts) {
    opts = opts || {};
    this.photos = [];   // [{src, name}]
    this.onChange = opts.onChange || null;
    this.container = null;
    this.inputEl = null;
    this.thumbsEl = null;
    this.metaEl = null;
  }

  PhotoUpload.prototype.attach = function (container) {
    var self = this;
    this.container = container;
    container.innerHTML =
      '<div class="photo-drop">📷 点击或拖拽上传照片，作为现场留存凭证（可多张）<br/>' +
        '<span style="font-size:12px;opacity:.7">手机点按直接拍照（iOS/Android 均支持）；想从相册选请用下方按钮</span></div>' +
      '<input type="file" accept="image/*" capture="environment" multiple hidden />' +
      '<input type="file" accept="image/*" multiple hidden class="photo-alt-input" />' +
      '<div class="thumbs"></div>' +
      '<div class="photo-meta"></div>';
    var drop = container.querySelector(".photo-drop");
    this.inputEl = container.querySelector("input[type=file]");
    this.altInputEl = container.querySelector(".photo-alt-input");
    this.thumbsEl = container.querySelector(".thumbs");
    this.metaEl = container.querySelector(".photo-meta");

    drop.addEventListener("click", function () { self.inputEl.click(); });
    // 「从相册选择」辅助按钮：capture=environment 强制调相机时，需要无 capture 的 input 走相册
    var altBtn = document.createElement("button");
    altBtn.type = "button";
    altBtn.className = "btn ghost sm";
    altBtn.textContent = "🖼️ 从相册选择";
    altBtn.style.marginTop = "8px";
    altBtn.addEventListener("click", function (e) { e.stopPropagation(); self.altInputEl.click(); });
    container.insertBefore(altBtn, this.thumbsEl);
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.style.borderColor = "var(--primary)"; });
    drop.addEventListener("dragleave", function () { drop.style.borderColor = ""; });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.style.borderColor = "";
      self.handleFiles(e.dataTransfer.files);
    });
    this.inputEl.addEventListener("change", function () { self.handleFiles(self.inputEl.files); });
    this.altInputEl.addEventListener("change", function () { self.handleFiles(self.altInputEl.files); });
    this.thumbsEl.addEventListener("click", function (e) {
      var del = e.target.closest(".del");
      if (del) {
        e.stopPropagation();
        self.photos.splice(Number(del.getAttribute("data-i")), 1);
        self.render();
        self.emit();
        return;
      }
      var img = e.target.closest(".thumb img");
      if (img) Modal.show("照片预览", '<img class="preview-img" src="' + Util.esc(Util.safeUrl(img.src)) + '" alt="" />', { width: "fit-content" });
    });
    this.render();
  };

  PhotoUpload.prototype.handleFiles = function (fileList) {
    var self = this;
    var files = Array.prototype.slice.call(fileList).filter(function (f) { return f.type.startsWith("image/"); });
    if (!files.length) return;
    var pending = files.length;
    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        // 传入 file 而非仅 name：HEIC 兜底需用 createImageBitmap(file) 解码
        self.compress(reader.result, file, function () {
          if (--pending === 0) { self.render(); self.emit(); }
        });
      };
      reader.readAsDataURL(file);
    });
    this.inputEl.value = "";
  };

  /** 压缩：最大边 1024px / JPEG 0.6（2026-08-10 调优：原 1280/0.72，单张约减半）
      修复 P0：iPhone/微信拍的 HEIC 照片被静默丢弃。
      - new Image() 加载失败（HEIC 等）时，优先用 createImageBitmap(file) 兜底解码上传，让 iPhone 用户真能传成功；
      - 若 createImageBitmap 也不可用/失败，明确 toast 并跳过该文件（绝不静默丢、也不阻塞其它照片）；
      - settled 哨兵保证 done() 只调用一次，单张坏图不会让整次提交卡死或丢其它数据。 */
  PhotoUpload.prototype.compress = function (dataUrl, file, done) {
    var self = this;
    var name = (file && file.name) || "";
    var type = (file && file.type) || "";

    function toastFail(msg) {
      try { if (Util && Util.toast) Util.toast(msg, true); } catch (e) {}
    }

    // 把图像源（Image 或 ImageBitmap）画到 canvas 压缩为 JPEG dataURL 并压入 photos
    function drawAndPush(src) {
      var max = Config.PHOTO_MAX_EDGE;
      var w = src.width || src.naturalWidth || 0;
      var h = src.height || src.naturalHeight || 0;
      if (!w || !h) throw new Error("empty image dimension");
      if (w > max || h > max) {
        var r = Math.min(max / w, max / h);
        w = Math.round(w * r);
        h = Math.round(h * r);
      } else {
        w = Math.round(w);
        h = Math.round(h);
      }
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(src, 0, 0, w, h);
      var out = canvas.toDataURL("image/jpeg", Config.PHOTO_QUALITY);
      self.photos.push({ src: out, name: name });
    }

    var settled = false;
    function finish() { if (!settled) { settled = true; done(); } }

    // HEIC / 不兼容格式兜底：优先 createImageBitmap(file)；失败则清晰报错并跳过该文件（不静默丢、不阻塞其它）
    function tryBitmapFallback() {
      if (typeof createImageBitmap === "function" && file) {
        var timedOut = false;
        var t = setTimeout(function () {
          if (!settled) {
            timedOut = true;
            toastFail("该照片处理超时，已跳过，请换 JPG/PNG 或重拍");
            finish();
          }
        }, 15000);
        createImageBitmap(file).then(function (bmp) {
          if (timedOut) { try { bmp.close && bmp.close(); } catch (e) {} return; }
          clearTimeout(t);
          try {
            drawAndPush(bmp);
            try { bmp.close && bmp.close(); } catch (e) {}
            finish();
          } catch (e) {
            toastFail("该照片处理失败，已跳过，请换 JPG/PNG 或重拍");
            finish();
          }
        }).catch(function () {
          clearTimeout(t);
          toastFail("该照片处理失败，已跳过，请换 JPG/PNG 或重拍");
          finish();
        });
      } else {
        toastFail("该照片格式不支持，已跳过，请换 JPG/PNG 或重拍");
        finish();
      }
    }

    var img = new Image();
    img.onload = function () {
      try { drawAndPush(img); finish(); }
      catch (e) { tryBitmapFallback(); }
    };
    // 加载失败（HEIC 等）：走 createImageBitmap 兜底；兜底也失败则明确报错并跳过
    img.onerror = function () { tryBitmapFallback(); };
    img.src = dataUrl;
  };

  PhotoUpload.prototype.render = function () {
    var self = this;
    this.thumbsEl.innerHTML = "";
    this.photos.forEach(function (p, i) {
      var t = document.createElement("div");
      t.className = "thumb";
      t.innerHTML = '<img src="' + Util.esc(Util.safeUrl(p.src)) + '" alt="" /><span class="del" data-i="' + i + '">&times;</span>';
      self.thumbsEl.appendChild(t);
    });
    var kb = Math.round(this.photos.reduce(function (s, p) { return s + p.src.length * 0.75 / 1024; }, 0));
    this.metaEl.textContent = this.photos.length
      ? "已选 " + this.photos.length + " 张照片（约 " + kb + " KB，已自动压缩）"
      : "";
  };

  PhotoUpload.prototype.getPhotos = function () {
    return this.photos.map(function (p) { return p.src; });
  };

  PhotoUpload.prototype.setPhotos = function (arr) {
    this.photos = (arr || []).map(function (src) { return { src: src, name: "" }; });
    this.render();
  };


  /* ================= 提交成功动效（D1，2026-08-08 新增） ================= */
  var fxStyleInjected = false;
  /** 提交成功页随机暖心话（每次随机一条，长期可扩展） */
  /* ================= 开心大转盘（2026-09-26，主理人要求） =================
     提交成功后的彩蛋：点一下转盘 → 炫技转 3 秒 → 随机蹦出一句夸人的话。
     纯前端表现层，不参与任何业务/数据逻辑，转出的结果也不落库。 */

  /* 8 个扇区：emoji + 短词 + 低饱和配色（沿用系统主色系） */
  var WHEEL_SECTORS = [
    { e: "✨", t: "闪光", bg: "#A8D5C2" },
    { e: "💛", t: "好运", bg: "#F2DFA8" },
    { e: "🍀", t: "顺利", bg: "#BEDCC6" },
    { e: "🎁", t: "惊喜", bg: "#F1CFC4" },
    { e: "🌟", t: "闪耀", bg: "#CFC7E8" },
    { e: "🎈", t: "开心", bg: "#F6D9C0" },
    { e: "💎", t: "值钱", bg: "#BFD8E8" },
    { e: "🌈", t: "甜一整天", bg: "#E5CDE0" }
  ];

  /* 100 句随机话术：分五类，不肉麻、有网感、多为夸"人"而非夸"事" */
  var WHEEL_LINES = [
    /* —— 夸颜值 —— */
    "你今天真好看",
    "你今天怎么这么好看？",
    "说实话，你今天有点耀眼",
    "你这状态，比昨天还精神",
    "认真做事的人最好看，说的就是你",
    "你今天气色好得离谱",
    "这一单很配你的气质",
    "你笑起来应该更好看",
    "今天这身打扮，库存都多看了两眼",
    "别人是来干活的，你是来发光的",
    "你今天的颜值，值得报备一下",
    "好看的人连登记都这么快",
    "你今天帅得很安静",
    "这份状态，建议长期保持",
    "你往这儿一站，办公室都亮了",
    "长得好看还这么靠谱，有点犯规",
    "今天的你，值得被夸三次",
    "你现在的样子，就是「靠谱」的样子",
    "有点羡慕你今天的精气神",
    "这一单，长得和你一样利落",
    /* —— 夸靠谱能干 —— */
    "这事儿交给你，稳了",
    "又快又准，专业",
    "你办事，我放心",
    "这一单干净得挑不出刺",
    "库存谢谢你",
    "你就是那种「交给他就没问题」的人",
    "手速惊人，全程零差错",
    "有你在，流程都顺了",
    "这效率，别人得追一阵",
    "你是团队里那颗定心丸",
    "干得漂亮，不用谦虚",
    "一单不乱，全靠你稳",
    "你今天处理事情的思路特别清晰",
    "这种细活儿，也就你能这么快",
    "你做事的样子特别有说服力",
    "这单登记得像教科书",
    "你的靠谱是能被看见的",
    "厉害的人连打勾都好看",
    "你把琐碎的事做得很有章法",
    "这就是传说中的「闭环」",
    /* —— 好运吉利 —— */
    "今天顺得有点离谱",
    "这一单开了个好头",
    "好运正在来找你的路上",
    "今天的运气值已经满格",
    "星星今天站你这边",
    "你今天的运气，建议分我一点",
    "好事会一件接一件",
    "今天诸事皆宜",
    "这一单很吉利",
    "运气这种事，你从来不缺",
    "今天你会遇到一点小惊喜",
    "幸运在排队等你",
    "你今天的运气好得像有人开挂",
    "今天适合干大事",
    "财运正在靠近你",
    "这一单，顺顺利利",
    "今天的风向对你有利",
    "你值得一整天都顺",
    "好运是你的默认设置",
    "今天的世界对你很温柔",
    /* —— 轻松逗趣 —— */
    "库存都替你高兴",
    "这一单干净得像刚洗过的数据",
    "系统都想给你鼓掌",
    "你按下的不是提交，是快乐",
    "表格看了都说好",
    "你这手速，键盘都跟不上",
    "这条数据长得特别正",
    "你现在价值连城",
    "别怀疑，你就是很棒",
    "连打印机都想为你欢呼",
    "你把一件小事做出了仪式感",
    "系统提示：检测到一位高手",
    "这一单，堪称艺术品",
    "你不是在登记，是在创作",
    "数据世界的秩序由你守护",
    "你今天的输出质量超标了",
    "建议给自己倒杯水，辛苦了",
    "这一单值得配一个下午茶",
    "你现在做的事，很重要",
    "解锁隐藏成就：稳如老狗",
    /* —— 温柔打气 —— */
    "你今天也辛苦了",
    "慢慢来，你已经做得很好",
    "每一条记录都是你的认真",
    "你今天很努力，值得被看见",
    "谢谢你今天这么认真",
    "做得好，也记得休息",
    "你在把事情一点点变好",
    "你今天的样子，很踏实",
    "你已经比昨天更熟练了",
    "这一单是你今天的小成就",
    "认真生活的人，运气不会差",
    "你今天的状态值得表扬",
    "别太累，你已经很好了",
    "你做的每件小事都有意义",
    "今天的你，值得一句「厉害」",
    "保持这个节奏，很稳",
    "你正在成为更好的自己",
    "谢谢你让流程转得更顺",
    "你今天完成的，比你以为的多",
    "新的记录，新的开始"
  ];

  var WARM_LINES = [
    "每一份登记，都是你为出库流程多节省的一分钟。",
    "今日的每一单，都会被明天记得。",
    "数据已入云，随时随地可以查看。",
    "你的认真，让库存更可靠。",
    "让每一支货品都去到它该去的地方。",
    "慢慢的，记录会成为你最可靠的助手。",
    "记录完成，可以短暂休息一下眼睛。",
    "今天你又为系统贡献了一条干净的数据。",
    "每一次确认，都让团队少一点疑问。",
    "做事有度，登记有数——你已经在路上了。",
    "把繁琐留给系统，把清爽留给自己。",
    "你的细心，是这家公司最便宜的资产。"
  ];

  /** 注入动效与单号标签样式（一次性；沿用青屿主题变量，无自定义文件） */
  function ensureFxStyle() {
    if (fxStyleInjected) return;
    fxStyleInjected = true;
    var st = document.createElement("style");
    st.textContent =
      ".fx-success{position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(43,63,55,.42);backdrop-filter:blur(2px);opacity:0;transition:opacity .22s;}" +
      ".fx-success.show{opacity:1;}" +
      ".fx-success-card{position:relative;width:min(340px,90vw);background:#FDFCF9;border:1px solid #DCE6E0;border-radius:20px;padding:32px 24px 22px;text-align:center;box-shadow:0 22px 60px rgba(30,50,42,.35);transform:translateY(12px) scale(.96);transition:transform .28s cubic-bezier(.2,.9,.3,1.2);}" +
      ".fx-success.show .fx-success-card{transform:translateY(0) scale(1);}" +
      ".fx-success .stage{position:relative;width:96px;height:96px;margin:0 auto 4px;}" +
      ".fx-success .fx-particles{position:absolute;inset:0;pointer-events:none;overflow:visible;}" +
      ".fx-success .fx-particles .p{position:absolute;left:50%;top:50%;width:6px;height:6px;border-radius:50%;opacity:0;transform:translate(-50%,-50%) scale(.3);}" +
      ".fx-success.show .fx-particles .p{animation:fx-fly 1.35s cubic-bezier(.15,.55,.35,1) forwards;}" +
      "@keyframes fx-fly{0%{opacity:0;transform:translate(-50%,-50%) scale(.3);}15%{opacity:1;transform:translate(calc(-50% + var(--fx-dx) * .25),calc(-50% + var(--fx-dy) * .25)) scale(1);}55%{opacity:1;}100%{opacity:0;transform:translate(calc(-50% + var(--fx-dx)),calc(-50% + var(--fx-dy))) scale(.55);}}" +
      ".fx-success .check{position:absolute;inset:0;margin:auto;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#7FB08E,#5E9A79);display:flex;align-items:center;justify-content:center;box-shadow:0 12px 26px rgba(87,130,111,.45);z-index:1;}" +
      ".fx-success .check svg{width:30px;height:30px;}" +
      ".fx-success .check path{stroke:#fff;stroke-width:3.4;stroke-linecap:round;stroke-linejoin:round;fill:none;stroke-dasharray:40;stroke-dashoffset:40;}" +
      ".fx-success.show .check path{animation:fx-draw .5s ease-out .15s forwards;}" +
      "@keyframes fx-draw{to{stroke-dashoffset:0;}}" +
      ".fx-success .order-no{display:inline-block;margin-top:10px;font-size:11.5px;font-weight:600;color:#57826F;background:#EAF4EF;border:1px solid rgba(185,214,199,.8);border-radius:999px;padding:2px 12px;white-space:nowrap;}" +
      ".fx-success h3{margin:12px 0 4px;font-size:19px;font-weight:800;color:#2F403A;letter-spacing:.5px;}" +
      ".fx-success .warm{margin:2px 0 18px;font-size:12.5px;line-height:1.75;color:#74837E;opacity:0;}" +
      ".fx-success.show .warm{animation:fx-rise .4s ease-out .5s forwards;}" +
      "@keyframes fx-rise{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}" +
      ".fx-success .actions{display:flex;gap:10px;justify-content:center;}" +
      ".fx-success .actions button{flex:1 1 0;min-width:0;padding:10px 0;border-radius:11px;border:1px solid #C6DAD1;background:#fff;color:#3C4845;font-size:13.5px;font-weight:600;cursor:pointer;}" +
      ".fx-success .actions button.primary{background:linear-gradient(135deg,#7FB08E,#5E9A79);border-color:transparent;color:#fff;}" +
      ".recent-item-no{display:inline-block;font-size:11px;font-weight:600;color:var(--mint-600,#57826F);background:var(--mint-100,#EAF4EF);border:1px solid rgba(185,214,199,.7);border-radius:999px;padding:1px 8px;margin-left:8px;vertical-align:1px;white-space:nowrap;}" +
      /* ===== 开心大转盘（2026-09-26）===== */
      ".fx-wheel-card{width:min(380px,92vw);padding:26px 22px 20px;}" +
      ".fx-wheel-wrap{display:flex;flex-direction:column;align-items:center;margin-top:6px;}" +
      ".fx-wheel{position:relative;width:236px;height:236px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .45s cubic-bezier(.3,.9,.4,1),opacity .45s,filter .45s;}" +
      ".fx-wheel.dim{transform:scale(.88);opacity:.38;filter:saturate(.65);}" +
      /* 外圈金环 + 跑马灯灯泡 */
      ".fx-wheel-ring{position:absolute;inset:-12px;border-radius:50%;background:linear-gradient(135deg,#F3EAD6,#DCC9A2 42%,#BFA87A);box-shadow:0 12px 28px rgba(88,78,48,.28),inset 0 2px 5px rgba(255,255,255,.75);}" +
      ".fx-wheel-ring i{position:absolute;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:#FFF9EA;box-shadow:0 0 7px rgba(255,236,180,.95);opacity:.4;transition:opacity .2s,transform .2s;}" +
      ".fx-wheel.spin .fx-wheel-ring i{opacity:1;animation:fxBulb 1.05s linear infinite;}" +
      "@keyframes fxBulb{0%,100%{transform:scale(1);box-shadow:0 0 7px rgba(255,236,180,.95);}50%{transform:scale(1.5);box-shadow:0 0 14px rgba(255,214,120,1);}}" +
      /* 盘面：8 扇区用 conic-gradient 铺色 */
      ".fx-wheel-rotor{position:absolute;inset:0;border-radius:50%;overflow:hidden;transition:transform .18s ease-out;will-change:transform;" +
        "background:conic-gradient(#A8D5C2 0 45deg,#F2DFA8 45deg 90deg,#BEDCC6 90deg 135deg,#F1CFC4 135deg 180deg,#CFC7E8 180deg 225deg,#F6D9C0 225deg 270deg,#BFD8E8 270deg 315deg,#E5CDE0 315deg 360deg);" +
        "box-shadow:inset 0 0 0 5px #FFFDF8,inset 0 0 26px rgba(255,255,255,.6),0 12px 30px rgba(60,90,75,.2);}" +
      /* 扇区里的 emoji + 短词（整体旋转到扇区中线，再反向旋正文字） */
      ".fx-wheel-sec{position:absolute;left:50%;top:50%;width:66px;margin:-33px 0 0 -33px;text-align:center;pointer-events:none;}" +
      ".fx-wheel-sec b{display:block;font-size:17px;line-height:1.1;font-weight:400;}" +
      ".fx-wheel-sec span{display:block;font-size:9.5px;color:#44604F;letter-spacing:.2px;margin-top:1px;}" +
      /* 中心按钮 */
      ".fx-wheel-hub{position:absolute;left:50%;top:50%;width:76px;height:76px;margin:-38px 0 0 -38px;border-radius:50%;z-index:3;" +
        "background:radial-gradient(circle at 34% 28%,#93C7B0,#5E9A79 72%);color:#fff;font-size:13px;font-weight:700;letter-spacing:.5px;" +
        "display:flex;align-items:center;justify-content:center;box-shadow:0 9px 22px rgba(70,120,98,.45),inset 0 2px 7px rgba(255,255,255,.5);}" +
      ".fx-wheel.idle .fx-wheel-hub{animation:fxHub 2s ease-in-out infinite;}" +
      "@keyframes fxHub{0%,100%{transform:scale(1);box-shadow:0 9px 22px rgba(70,120,98,.45),inset 0 2px 7px rgba(255,255,255,.5);}50%{transform:scale(1.07);box-shadow:0 9px 30px rgba(70,130,104,.62),inset 0 2px 7px rgba(255,255,255,.5);}}" +
      ".fx-wheel.spin .fx-wheel-hub{animation:fxHubSpin .85s ease-in-out infinite;}" +
      "@keyframes fxHubSpin{0%,100%{transform:scale(1);}50%{transform:scale(1.15);}}" +
      ".fx-wheel-hub:active{transform:scale(.93);}" +
      /* 顶部指针 */
      ".fx-wheel-pin{position:absolute;left:50%;top:-17px;margin-left:-12px;width:0;height:0;z-index:4;" +
        "border-left:12px solid transparent;border-right:12px solid transparent;border-top:21px solid #4E8A6B;" +
        "filter:drop-shadow(0 3px 4px rgba(45,75,60,.4));}" +
      /* 提示与结果 */
      ".fx-wheel-tip{margin-top:16px;font-size:12.5px;color:#7A8A85;text-align:center;min-height:18px;}" +
      ".fx-wheel-lines{margin-top:8px;min-height:76px;display:flex;align-items:center;justify-content:center;padding:0 6px;}" +
      ".fx-wheel-lines .line{font-size:20px;font-weight:700;color:#2F4A3E;line-height:1.5;text-align:center;opacity:0;transform:scale(.55) translateY(8px);" +
        "transition:transform .52s cubic-bezier(.2,1.55,.4,1),opacity .3s ease-out;}" +
      ".fx-wheel-lines.show .line{opacity:1;transform:scale(1) translateY(0);}" +
      /* 撒落星星 */
      ".fx-wheel-confetti{position:absolute;inset:0;pointer-events:none;overflow:hidden;border-radius:20px;z-index:9;}" +
      ".fx-wheel-confetti span{position:absolute;top:-16px;opacity:0;animation:fxFall 1.7s cubic-bezier(.25,.6,.4,1) forwards;}" +
      "@keyframes fxFall{0%{opacity:0;transform:translateY(0) rotate(0);}12%{opacity:1;}100%{opacity:0;transform:translateY(400px) rotate(var(--fx-rot,360deg));}}" +
      "html[data-theme=\"dark\"] .fx-wheel-lines .line{color:#E8E4DD;}" +
      "html[data-theme=\"dark\"] .fx-wheel-sec span{color:#3F5A4C;}" +
      "html[data-theme=\"dark\"] .fx-success-card.fx-wheel-card{background:#2A3632;border-color:#3E4F49;}" +
      "html[data-theme=\"dark\"] .fx-wheel-ring{background:linear-gradient(135deg,#7A6E52,#5C523A 42%,#453E2C);}";
    document.head.appendChild(st);
  }

  /** 提交成功全屏页面（体验升级）：粒子烟花绽放 + 中央 ✓ + 单号胶囊 + 随机暖心话 + 自动关闭。
      opts: { orderNo?, target? } */
  function celebrate(opts) {
    opts = opts || {};
    ensureFxStyle();
    var old = document.querySelector(".fx-success");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var orderNo = opts.orderNo || "";
    var warm = WARM_LINES[Math.floor(Math.random() * WARM_LINES.length)];
    var el = document.createElement("div");
    el.className = "fx-success";
    /* 8 个扇区的 emoji + 短词：先整体旋到扇区中线，再把文字反向旋正 */
    var secHtml = "";
    for (var si = 0; si < WHEEL_SECTORS.length; si++) {
      var sAng = si * 45 + 22.5;
      secHtml += '<div class="fx-wheel-sec" style="transform:rotate(' + sAng + 'deg) translateY(-77px) rotate(' + (-sAng) + 'deg)">' +
        '<b>' + WHEEL_SECTORS[si].e + '</b><span>' + WHEEL_SECTORS[si].t + '</span></div>';
    }

    el.innerHTML =
      '<div class="fx-success-card fx-wheel-card">' +
        (orderNo ? '<span class="order-no">' + Util.esc(orderNo) + '</span>' : '') +
        '<div class="fx-wheel-wrap">' +
          '<div class="fx-wheel idle" id="fxWheel">' +
            '<div class="fx-wheel-pin"></div>' +
            '<div class="fx-wheel-ring" id="fxWheelRing"></div>' +
            '<div class="fx-wheel-rotor" id="fxWheelRotor">' + secHtml + '</div>' +
            '<div class="fx-wheel-hub">点我</div>' +
          '</div>' +
          '<div class="fx-wheel-tip" id="fxWheelTip">点一下转盘，看看今天的彩蛋 ✨</div>' +
        '</div>' +
        '<div class="fx-wheel-lines" id="fxWheelLines"></div>' +
        '<div class="actions" id="fxWheelActs" style="visibility:hidden">' +
          '<button type="button" data-act="again">再转一次</button>' +
          (orderNo ? '<button type="button" data-act="view">查看最新记录</button>' : '') +
          '<button type="button" class="primary" data-act="close">知道了</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    /* ---------- 开心大转盘交互（纯表现层，不碰任何业务数据） ---------- */
    var wheel = el.querySelector("#fxWheel");
    var rotor = el.querySelector("#fxWheelRotor");
    var ring = el.querySelector("#fxWheelRing");
    var tip = el.querySelector("#fxWheelTip");
    var linesBox = el.querySelector("#fxWheelLines");
    var actsBox = el.querySelector("#fxWheelActs");
    var spinning = false;
    var rotorDeg = 0;

    /* 外圈 12 颗灯泡，沿圆周均匀分布 */
    if (ring) {
      for (var bi = 0; bi < 12; bi++) {
        var ba = bi * 30 * Math.PI / 180;
        var bulb = document.createElement("i");
        bulb.style.left = "calc(50% + " + (Math.cos(ba) * 123).toFixed(1) + "px)";
        bulb.style.top = "calc(50% + " + (Math.sin(ba) * 123).toFixed(1) + "px)";
        bulb.style.animationDelay = (bi * 0.085).toFixed(3) + "s";
        ring.appendChild(bulb);
      }
    }

    /* 撒星星 */
    function confetti() {
      var box = document.createElement("div");
      box.className = "fx-wheel-confetti";
      var colors = ["#F2D06B", "#A8D5C2", "#C9C2E8", "#F1CFC4", "#9FD3E8", "#EFB6D3"];
      var glyphs = ["✦", "✧", "★", "✿", "❋"];
      for (var ci = 0; ci < 36; ci++) {
        var sp = document.createElement("span");
        sp.textContent = glyphs[ci % glyphs.length];
        sp.style.color = colors[ci % colors.length];
        sp.style.left = (Math.random() * 100).toFixed(1) + "%";
        sp.style.fontSize = (9 + Math.random() * 11).toFixed(1) + "px";
        sp.style.animationDelay = (Math.random() * 0.45).toFixed(2) + "s";
        sp.style.setProperty("--fx-rot", (Math.random() * 720 - 360).toFixed(0) + "deg");
        box.appendChild(sp);
      }
      el.querySelector(".fx-success-card").appendChild(box);
      setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 3800);
    }

    /* 转动：蓄力 → 高速 4~5 圈 → 过冲缓停，全程 3 秒 → 揭晓话术 */
    function spin() {
      if (spinning) return;
      spinning = true;
      wheel.classList.remove("idle", "dim");
      wheel.classList.add("spin");
      linesBox.classList.remove("show");
      linesBox.innerHTML = "";
      actsBox.style.visibility = "hidden";
      tip.textContent = "转起来啦…";

      var turns = 4 + Math.floor(Math.random() * 2);          /* 4 或 5 圈 */
      var target = rotorDeg + turns * 360 + 22.5 + Math.floor(Math.random() * 8) * 45;

      /* ① 蓄力：反向回撤 14°，那一下回缩最抓人 */
      rotor.style.transition = "transform .18s ease-out";
      rotor.style.transform = "rotate(" + (rotorDeg - 14) + "deg)";

      /* ② 主旋：突然加速转出去，曲线前段猛、后段缓 */
      setTimeout(function () {
        rotor.style.transition = "transform 2.72s cubic-bezier(.12,.72,.16,1)";
        rotor.style.transform = "rotate(" + target + "deg)";
        rotorDeg = target;
      }, 180);

      /* ③ 停稳揭晓：转盘后退让位 → 话术从小到大弹出 → 撒星星 */
      setTimeout(function () {
        spinning = false;
        wheel.classList.remove("spin");
        wheel.classList.add("dim");
        var line = WHEEL_LINES[Math.floor(Math.random() * WHEEL_LINES.length)];
        linesBox.innerHTML = '<div class="line">✨ ' + Util.esc(line) + ' ✨</div>';
        tip.textContent = "";
        requestAnimationFrame(function () { linesBox.classList.add("show"); });
        confetti();
        actsBox.style.visibility = "visible";
      }, 3000);
    }

    if (wheel) wheel.addEventListener("click", spin);

    // 烟花粒子：70 颗从中心向四周随机角度爆裂，颜色随机、距离随机、稍错延迟
    var host = el.querySelector("#fxBurstHost");
    if (host) {
      var palette = ["#FF5757", "#FFD93D", "#6BCB77", "#4D96FF", "#FF6BCB", "#9D5CFF", "#FFA94D", "#3DCCFF"];
      for (var i = 0; i < 70; i++) {
        var p = document.createElement("span");
        p.className = "p";
        var ang = Math.random() * Math.PI * 2;
        var dist = 70 + Math.random() * 130;     // px，最终扩散距离
        p.style.setProperty("--fx-dx", Math.cos(ang) * dist + "px");
        p.style.setProperty("--fx-dy", Math.sin(ang) * dist + "px");
        var c = palette[i % palette.length];
        var sz = 5 + Math.random() * 6;
        p.style.background = c;
        p.style.width = sz + "px";
        p.style.height = sz + "px";
        p.style.boxShadow = "0 0 6px " + c;
        p.style.animationDelay = (Math.random() * 0.22) + "s";
        host.appendChild(p);
      }
    }
    requestAnimationFrame(function () { el.classList.add("show"); });
    function close() {
      el.classList.remove("show");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (!b) { if (e.target === el) close(); return; }
      var act = b.getAttribute("data-act");
      if (act === "close") close();
      else if (act === "again") spin();
      else if (act === "view") {
        close();
        var target = opts.target || document.getElementById("recentBox") || document.getElementById("recListBox");
        if (target && typeof target.scrollIntoView === "function") {
          try { target.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) {}
        } else {
          try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) {}
        }
      }
    });
    // 转盘是主动交互，不能被超时打断：只留一个宽松兜底（40 秒防卡住），主要靠「知道了」关闭
    setTimeout(function () { if (document.body.contains(el)) close(); }, 40000);
  }

  /* ============================================================
     字段级错误提示（替代「一次只弹一条 toast」的校验反馈）
     放在 components.js 是因为它先于全部 views 加载，依赖方向天然正确。
     ============================================================ */

  /** 由任意控件上溯到它所属的 .field 容器；找不到则回退到控件自身的父节点 */
  function fieldOf(el) {
    if (!el) return null;
    return (el.closest && el.closest(".field")) || el.parentNode || null;
  }

  /**
   * 在指定控件所属字段上标注错误
   * @param {Element} el   出错的控件（input / textarea / chip 容器 / picker 容器）
   * @param {string}  msg  错误文案
   * @returns {Element|null} 被标注的 .field 容器
   */
  function showFieldError(el, msg) {
    var field = fieldOf(el);
    if (!field) return null;
    field.classList.add("has-error");
    var tip = field.querySelector(":scope > .field-error");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "field-error";
      field.appendChild(tip);
    }
    tip.textContent = msg || "";
    // 让读屏与校验语义可感知
    if (el && el.setAttribute && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      el.setAttribute("aria-invalid", "true");
    }
    return field;
  }

  /** 清除 root（默认整个文档）范围内的全部字段错误标注 */
  function clearFieldErrors(root) {
    var scope = root || document;
    var marked = scope.querySelectorAll(".field.has-error");
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove("has-error");
    var tips = scope.querySelectorAll(".field-error");
    for (var j = 0; j < tips.length; j++) {
      if (tips[j].parentNode) tips[j].parentNode.removeChild(tips[j]);
    }
    var invalid = scope.querySelectorAll('[aria-invalid="true"]');
    for (var k = 0; k < invalid.length; k++) invalid[k].removeAttribute("aria-invalid");
  }

  /**
   * 一次性上报一组校验错误：清旧 → 全部标注 → 滚动定位到第一个 → 聚焦
   * @param {Array<{el:Element,msg:string,focus?:boolean}>} list 为空表示校验通过
   * @param {Element} [root] 清理范围
   * @returns {boolean} true 表示校验通过（list 为空）
   */
  function reportFieldErrors(list, root) {
    clearFieldErrors(root);
    if (!list || !list.length) return true;
    var firstField = null;
    var firstFocusable = null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item) continue;
      var f = showFieldError(item.el, item.msg);
      if (!firstField && f) {
        firstField = f;
        if (item.focus !== false && item.el && typeof item.el.focus === "function"
          && /^(INPUT|TEXTAREA|SELECT)$/.test(item.el.tagName)) {
          firstFocusable = item.el;
        }
      }
    }
    if (firstField && firstField.scrollIntoView) {
      try { firstField.scrollIntoView({ block: "center", behavior: "smooth" }); }
      catch (e) { firstField.scrollIntoView(); }
    }
    if (firstFocusable) {
      // 让平滑滚动先跑起来，再聚焦，避免移动端键盘弹出打断滚动
      setTimeout(function () { try { firstFocusable.focus({ preventScroll: true }); } catch (e) { firstFocusable.focus(); } }, 260);
    }
    return false;
  }

  window.App = window.App || {};
  window.App.UI = {
    icon: icon,
    Modal: Modal,
    confirmSubmit: confirmSubmit,
    confirmDialog: confirmDialog,
    promptDialog: promptDialog,
    showLoginDialog: showLoginDialog,
    collapseSection: collapseSection,
    bindCollapse: bindCollapse,
    ProductPicker: ProductPicker,
    PhotoUpload: PhotoUpload,
    celebrate: celebrate,
    showFieldError: showFieldError,
    clearFieldErrors: clearFieldErrors,
    reportFieldErrors: reportFieldErrors
  };
})();
