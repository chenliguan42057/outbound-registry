/**
 * components.js — 可复用 UI 组件
 * SVG 图标 / Modal / Confirm 弹窗 / 密码弹窗 / CollapseSection / ProductPicker / PhotoUpload
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;
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

  /** 密码弹窗（管理操作需密码）：Promise<boolean> */
  function pwDialog(title) {
    return new Promise(function (resolve) {
      var body =
        '<input type="password" class="pw-input" placeholder="请输入密码" autocomplete="off" />' +
        '<div class="pw-err"></div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
          '<button type="button" class="btn sm" data-act="ok">确认</button>' +
        '</div>';
      Modal.show(title || "此操作需要密码", body, { width: "320px" });
      var mBody = Modal.body();
      var input = mBody.querySelector(".pw-input");
      var errEl = mBody.querySelector(".pw-err");
      function ok() {
        if (window.App.Auth.checkPw(input.value)) { Modal.hide(); resolve(true); }
        else { errEl.textContent = "密码错误，请重试"; input.select(); }
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
  }

  ProductPicker.prototype.attach = function (container) {
    var self = this;
    this.container = container;
    container.innerHTML =
      '<div class="search-wrap">' +
        '<input type="text" class="search" placeholder="' + Util.esc(this.placeholder) + '" autocomplete="off" />' +
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
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".search-wrap")) self.suggestEl.style.display = "none";
    });
    this.listEl.addEventListener("click", function (e) {
      var x = e.target.closest(".x");
      if (x) {
        self.selected.splice(Number(x.getAttribute("data-i")), 1);
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
    if (!pool.length) { this.suggestEl.style.display = "none"; return; }
    pool.slice(0, 30).forEach(function (p) {
      var d = document.createElement("div");
      d.textContent = p;
      d.addEventListener("mousedown", function (ev) { ev.preventDefault(); self.addProduct(p); });
      self.suggestEl.appendChild(d);
    });
    this.suggestEl.style.display = "block";
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
        '<input type="number" min="0" step="any" value="' + Util.esc(it.qty) + '" class="qty" data-i="' + i + '" />' +
        '<span class="x" data-i="' + i + '">&times;</span>';
      self.listEl.appendChild(row);
    });
    this.hintEl.textContent = this.selected.length
      ? "已选 " + this.selected.length + " 项货品，请逐项确认数量。"
      : "尚未选择货品，请在上方搜索并选择。";
  };

  /** 获取有效货品 [{name, qty}]（qty>0） */
  ProductPicker.prototype.getItems = function () {
    return this.selected
      .map(function (s) { return { name: s.name, qty: s.qty === "" ? 0 : Number(s.qty) }; })
      .filter(function (s) { return s.name && s.qty > 0; });
  };

  ProductPicker.prototype.setSelected = function (arr) {
    this.selected = (arr || []).map(function (it) { return { name: it.name, qty: it.qty }; });
    this.render();
  };

  ProductPicker.prototype.emit = function () {
    if (this.onChange) this.onChange(this.getItems(), this.selected);
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

  window.App = window.App || {};
  window.App.UI = {
    icon: icon,
    Modal: Modal,
    confirmDialog: confirmDialog,
    pwDialog: pwDialog,
    collapseSection: collapseSection,
    bindCollapse: bindCollapse,
    ProductPicker: ProductPicker,
    PhotoUpload: PhotoUpload
  };
})();
