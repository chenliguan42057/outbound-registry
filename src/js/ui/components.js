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
    photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 15l-5-5-9 9"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14"/>',
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
          Modal.show("照片预览", '<img class="preview-img" src="' + src + '" alt="" />', { width: "fit-content" });
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

  /** 确认弹窗：Promise<boolean> */
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
      mBody.querySelector('[data-act="ok"]').onclick = function () { Modal.hide(); resolve(true); };
      mBody.querySelector('[data-act="cancel"]').onclick = function () { Modal.hide(); resolve(false); };
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
  }

  ProductPicker.prototype.attach = function (container) {
    var self = this;
    this.container = container;
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
        var next = qb.getAttribute("data-act") === "inc" ? cur + 1 : Math.max(0, cur - 1);
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
    this.render();
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
    this.selected.push({ name: name, qty: 1 });
    this.searchEl.value = "";
    this.suggestEl.style.display = "none";
    this.render();
    this.emit();
  };

  ProductPicker.prototype.render = function () {
    var self = this;
    this.listEl.innerHTML = "";
    this.selected.forEach(function (it, i) {
      var stock = window.App.Stock.getStock(it.name);
      var row = document.createElement("div");
      row.className = "sel-item";
      var stockHtml = "";
      if (self.showInStock) {
        var after = stock + (Number(it.qty) || 0);
        stockHtml = '<span class="stock">库存 ' + stock + ' → ' + after + '</span>';
      } else if (self.showStock) {
        stockHtml = '<span class="stock">库存：' + stock + '</span>';
      }
      row.innerHTML =
        '<span class="name">' + Util.esc(it.name) + '</span>' +
        stockHtml +
        '<div class="qty-stepper">' +
          '<button type="button" class="qty-btn" data-act="dec" data-i="' + i + '" aria-label="减少">−</button>' +
          '<input type="number" min="0" max="999999" step="any" inputmode="decimal" enterkeyhint="done" aria-label="' + Util.esc(it.name) + ' 数量" value="' + Util.esc(it.qty) + '" class="qty" data-i="' + i + '" />' +
          '<button type="button" class="qty-btn" data-act="inc" data-i="' + i + '" aria-label="增加">+</button>' +
        '</div>' +
        '<span class="x" data-i="' + i + '">&times;</span>';
      self.listEl.appendChild(row);
    });
    this.hintEl.textContent = this.selected.length
      ? "已选 " + this.selected.length + " 项货品，请逐项确认数量。"
      : "尚未选择货品，请在上方搜索并选择。";
  };

  /** 获取有效货品 [{name, qty}]（qty >= MIN_QTY 且 <= MAX_QTY，过滤掉 0.0001 这类误填） */
  ProductPicker.MIN_QTY = 0.001;
  ProductPicker.MAX_QTY = 999999;
  ProductPicker.prototype.getItems = function () {
    return this.selected
      .map(function (s) { return { name: s.name, qty: s.qty === "" ? 0 : Number(s.qty) }; })
      .filter(function (s) {
        return s.name && isFinite(s.qty)
          && s.qty >= ProductPicker.MIN_QTY && s.qty <= ProductPicker.MAX_QTY;
      });
  };

  /** 校验已选货品的数量填写情况，返回问题描述数组（供表单做字段级提示） */
  ProductPicker.prototype.validateItems = function () {
    var problems = [];
    this.selected.forEach(function (s) {
      var n = s.qty === "" ? 0 : Number(s.qty);
      if (!isFinite(n) || n <= 0) problems.push(s.name + " 未填数量");
      else if (n < ProductPicker.MIN_QTY) problems.push(s.name + " 数量过小");
      else if (n > ProductPicker.MAX_QTY) problems.push(s.name + " 数量超上限");
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
      '<div class="photo-drop">📷 点击或拖拽上传照片，作为现场留存凭证（可多张）</div>' +
      '<input type="file" accept="image/*" multiple hidden />' +
      '<div class="thumbs"></div>' +
      '<div class="photo-meta"></div>';
    var drop = container.querySelector(".photo-drop");
    this.inputEl = container.querySelector("input[type=file]");
    this.thumbsEl = container.querySelector(".thumbs");
    this.metaEl = container.querySelector(".photo-meta");

    drop.addEventListener("click", function () { self.inputEl.click(); });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.style.borderColor = "var(--primary)"; });
    drop.addEventListener("dragleave", function () { drop.style.borderColor = ""; });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.style.borderColor = "";
      self.handleFiles(e.dataTransfer.files);
    });
    this.inputEl.addEventListener("change", function () { self.handleFiles(self.inputEl.files); });
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
      if (img) Modal.show("照片预览", '<img class="preview-img" src="' + img.src + '" alt="" />', { width: "fit-content" });
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
        self.compress(reader.result, file.name, function () {
          if (--pending === 0) { self.render(); self.emit(); }
        });
      };
      reader.readAsDataURL(file);
    });
    this.inputEl.value = "";
  };

  /** 压缩：最大边 1280px / JPEG 0.72（与现网一致） */
  PhotoUpload.prototype.compress = function (dataUrl, name, done) {
    var self = this;
    var img = new Image();
    img.onload = function () {
      var max = Config.PHOTO_MAX_EDGE;
      var w = img.width, h = img.height;
      if (w > max || h > max) {
        var r = Math.min(max / w, max / h);
        w = Math.round(w * r);
        h = Math.round(h * r);
      }
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      var out = canvas.toDataURL("image/jpeg", Config.PHOTO_QUALITY);
      self.photos.push({ src: out, name: name || "" });
      done();
    };
    img.onerror = function () { done(); };
    img.src = dataUrl;
  };

  PhotoUpload.prototype.render = function () {
    var self = this;
    this.thumbsEl.innerHTML = "";
    this.photos.forEach(function (p, i) {
      var t = document.createElement("div");
      t.className = "thumb";
      t.innerHTML = '<img src="' + p.src + '" alt="" /><span class="del" data-i="' + i + '">&times;</span>';
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
      ".fx-celebrate{position:fixed;inset:0;z-index:85;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;transition:opacity .25s;}" +
      ".fx-celebrate.show{opacity:1;}" +
      ".fx-celebrate .fx-box{position:relative;width:120px;height:120px;display:flex;align-items:center;justify-content:center;}" +
      ".fx-celebrate .fx-ring{position:absolute;inset:0;border-radius:50%;border:2.5px solid rgba(111,169,138,.55);opacity:0;}" +
      ".fx-celebrate.show .fx-ring{animation:fx-ripple 1.1s ease-out .05s forwards;}" +
      ".fx-celebrate .fx-ring.r2{border-color:rgba(150,138,190,.5);animation-delay:.22s;}" +
      ".fx-celebrate .fx-ring.r3{border-color:rgba(111,163,168,.45);animation-delay:.4s;}" +
      "@keyframes fx-ripple{0%{transform:scale(.35);opacity:0;}30%{opacity:.9;}100%{transform:scale(1.35);opacity:0;}}" +
      ".fx-celebrate .fx-check{width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#7FB08E,#5E9A79);display:flex;align-items:center;justify-content:center;box-shadow:0 12px 30px rgba(87,130,111,.45);}" +
      ".fx-celebrate .fx-check svg{width:30px;height:30px;}" +
      ".fx-celebrate .fx-check path{stroke:#fff;stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round;fill:none;stroke-dasharray:40;stroke-dashoffset:40;}" +
      ".fx-celebrate.show .fx-check path{animation:fx-draw .5s ease-out .15s forwards;}" +
      "@keyframes fx-draw{to{stroke-dashoffset:0;}}" +
      ".fx-celebrate .fx-note{position:absolute;top:132px;left:50%;transform:translateX(-50%);width:max-content;max-width:86vw;text-align:center;font-size:13px;font-weight:600;color:var(--ink-900,#3C4845);background:rgba(253,252,249,.95);border:1px solid rgba(220,230,224,.9);border-radius:999px;padding:8px 18px;box-shadow:0 10px 26px rgba(87,130,111,.25);opacity:0;}" +
      ".fx-celebrate.show .fx-note{animation:fx-rise .4s ease-out .5s forwards;}" +
      "@keyframes fx-rise{from{opacity:0;transform:translateX(-50%) translateY(8px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}" +
      ".recent-item-no{display:inline-block;font-size:11px;font-weight:600;color:var(--mint-600,#57826F);background:var(--mint-100,#EAF4EF);border:1px solid rgba(185,214,199,.7);border-radius:999px;padding:1px 8px;margin-left:8px;vertical-align:1px;white-space:nowrap;}";
    document.head.appendChild(st);
  }

  /** 提交成功全屏页面（体验升级）：双层涟漪 + 打勾描边 + 单号胶囊 + 随机暖心话 + 自动关闭。
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
    el.innerHTML =
      '<div class="fx-success-card">' +
        '<div class="rings"><span class="ring"></span><span class="ring r2"></span><span class="ring r3"></span>' +
        '<span class="check"><svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg></span></div>' +
        (orderNo ? '<span class="order-no">' + Util.esc(orderNo) + '</span>' : '') +
        '<h3>提交成功</h3>' +
        '<div class="warm">' + Util.esc(warm) + '</div>' +
        '<div class="actions">' +
          '<button type="button" data-act="view">查看最新记录</button>' +
          '<button type="button" class="primary" data-act="close">知道了</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
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
    // 4.5 秒自动关闭（不强制，可点「知道了」立即关）
    setTimeout(function () { if (document.body.contains(el)) close(); }, 4500);
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
