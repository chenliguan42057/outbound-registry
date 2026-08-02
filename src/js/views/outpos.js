/**
 * outpos.js — POS 出库管理（管理页「出库管理」）
 * 扫码/手动添加明细；售价/小计/条码/单位仅会话展示，绝不落库。
 * 提单生成记录：{time, dept:客户, picker:经办人, purpose:备注, items:[{name,qty}], photos:[], affectsStock:true}
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;
  var State = window.App.State;
  var Records = window.App.Records;
  var Cloud = window.App.Cloud;
  var Stock = window.App.Stock;

  var els = null;
  var items = [];        // [{name, qty, price, unit}]
  var submitted = false; // 会话内提单状态徽标

  function render(container) {
    container.innerHTML =
      '<div class="pos-page">' +
        '<div class="pos-head">' +
          '<h1 class="pos-title">出库管理</h1>' +
          '<div class="pos-hint">价格与条码仅本次会话展示，不写入记录；提单后数据自动同步云端。</div>' +
        '</div>' +
        '<div class="pos-scan-row">' +
          '<input type="text" id="posScan" class="search pos-scan-input" placeholder="扫描或输入条码/货品名" autocomplete="off" />' +
          '<button type="button" class="btn pos-add-btn" id="posAdd">添加</button>' +
        '</div>' +
        '<div class="pos-body">' +
          '<div class="pos-card pos-detail-card">' +
            '<div class="pos-card-head">' +
              '<span class="pos-card-title">出库明细</span>' +
              '<span class="pos-badge" id="posBadge">未提单</span>' +
            '</div>' +
            '<div class="pos-table-wrap">' +
              '<table class="table pos-table">' +
                '<thead><tr><th>条码</th><th>商品名称</th><th>单位</th><th>库存</th><th>数量</th><th>售价</th><th>小计</th></tr></thead>' +
                '<tbody id="posItemsBody"></tbody>' +
              '</table>' +
              '<div class="empty" id="posEmpty">扫描商品条码或手动添加</div>' +
            '</div>' +
            '<div class="pos-card-actions">' +
              '<button type="button" class="btn ghost sm" id="posEdit">编辑</button>' +
              '<button type="button" class="btn-clear" id="posClear">清空</button>' +
            '</div>' +
          '</div>' +
          '<div class="pos-card pos-info-card">' +
            '<div class="pos-card-head"><span class="pos-card-title">出库信息</span></div>' +
            '<div class="field">' +
              '<label>客户<span class="req">*</span></label>' +
              '<input type="text" id="posCustomer" placeholder="客户名称" autocomplete="off" />' +
            '</div>' +
            '<div class="field">' +
              '<label>经办人</label>' +
              '<input type="text" id="posPicker" value="管理员" autocomplete="off" />' +
            '</div>' +
            '<div class="field">' +
              '<label>备注</label>' +
              '<textarea id="posRemark" rows="4" placeholder="备注信息(选填)"></textarea>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="btn btn-green pos-submit" id="posSubmit">确认提单</button>' +
      '</div>';

    els = {
      scan: Util.$("posScan"),
      add: Util.$("posAdd"),
      badge: Util.$("posBadge"),
      itemsBody: Util.$("posItemsBody"),
      empty: Util.$("posEmpty"),
      edit: Util.$("posEdit"),
      clear: Util.$("posClear"),
      customer: Util.$("posCustomer"),
      picker: Util.$("posPicker"),
      remark: Util.$("posRemark"),
      submit: Util.$("posSubmit")
    };

    els.scan.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); handleAdd(); }
    });
    els.add.addEventListener("click", handleAdd);
    els.edit.addEventListener("click", unlockEdit);
    els.clear.addEventListener("click", clearAll);
    els.submit.addEventListener("click", submit);
    els.itemsBody.addEventListener("input", onItemInput);

    renderItems();
  }

  /* ================= 添加明细 ================= */

  /** 输入匹配：条码精确 → 名称精确 → 首个包含建议 */
  function matchProduct(v) {
    if (Config.BARCODE_MAP && Config.BARCODE_MAP[v]) return Config.BARCODE_MAP[v];
    for (var i = 0; i < Config.PRODUCTS.length; i++) {
      if (Config.PRODUCTS[i] === v) return Config.PRODUCTS[i];
    }
    var q = v.toLowerCase();
    for (var j = 0; j < Config.PRODUCTS.length; j++) {
      if (Config.PRODUCTS[j].toLowerCase().indexOf(q) !== -1) return Config.PRODUCTS[j];
    }
    return null;
  }

  function handleAdd() {
    var v = els.scan.value.trim();
    if (!v) { Util.toast("请输入条码或货品名", true); return; }
    var name = matchProduct(v);
    if (!name) { Util.toast("未找到货品「" + v.slice(0, 12) + "」", true); return; }
    addItemByName(name);
    els.scan.value = "";
    els.scan.focus();
  }

  function addItemByName(name) {
    var existing = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].name === name) { existing = items[i]; break; }
    }
    if (existing) {
      existing.qty += 1;
    } else {
      items.push({
        name: name,
        qty: 1,
        price: (Config.PRICE_MAP && Config.PRICE_MAP[name]) || 0,
        unit: parseUnit(name)
      });
    }
    renderItems();
  }

  /** 单位 = 名称正则解析，未命中默认「件」 */
  function parseUnit(name) {
    if (name.indexOf("支装") !== -1) return "支";
    if (name.indexOf("片装") !== -1) return "片";
    if (/ml/i.test(name)) return "ml";
    if (/g/i.test(name)) return "g";
    if (name.indexOf("礼盒装") !== -1) return "盒";
    if (name.indexOf("袋") !== -1) return "袋";
    return "件";
  }

  /* ================= 明细渲染 ================= */

  function renderItems() {
    els.empty.style.display = items.length ? "none" : "";
    if (!items.length) { els.itemsBody.innerHTML = ""; return; }
    var html = "";
    items.forEach(function (it, i) {
      var stock = Stock.getStock(it.name);
      var subtotal = ((Number(it.qty) || 0) * (Number(it.price) || 0)).toFixed(2);
      var priceVal = Number(it.price) === 0 ? "" : Number(it.price);
      html += '<tr>' +
        '<td>&mdash;</td>' +
        '<td>' + Util.esc(it.name) + '</td>' +
        '<td>' + Util.esc(it.unit) + '</td>' +
        '<td>' + stock + '</td>' +
        '<td><input type="number" min="0" step="any" class="pos-qty" data-i="' + i + '" value="' + it.qty + '" /></td>' +
        '<td><input type="number" min="0" step="any" class="pos-price" data-i="' + i + '" placeholder="0" value="' + priceVal + '" /></td>' +
        '<td class="pos-subtotal">' + subtotal + '</td>' +
      '</tr>';
    });
    els.itemsBody.innerHTML = html;
  }

  /** 数量/售价编辑（事件委托） */
  function onItemInput(e) {
    var inp = e.target.closest(".pos-qty, .pos-price");
    if (!inp) return;
    var i = Number(inp.getAttribute("data-i"));
    var it = items[i];
    if (!it) return;
    if (inp.classList.contains("pos-qty")) {
      it.qty = Math.max(0, Number(inp.value) || 0);
    } else {
      it.price = Math.max(0, Number(inp.value) || 0);
    }
    renderItems();
  }

  /* ================= 提单 / 编辑 / 清空 ================= */

  function submit() {
    if (submitted) { Util.toast("已提单，如需调整请先点「编辑」", true); return; }
    var valid = items.filter(function (it) { return (Number(it.qty) || 0) > 0; });
    var customer = els.customer.value.trim();
    if (!valid.length) { Util.toast("请至少添加一项出库明细", true); return; }
    if (!customer) { Util.toast("请填写客户名称", true); return; }
    var payload = {
      time: Util.nowLocal(),
      dept: customer,
      picker: els.picker.value.trim() || "管理员",
      purpose: els.remark.value.trim(),
      items: valid.map(function (it) { return { name: it.name, qty: it.qty }; }),
      photos: [],
      affectsStock: true
    };
    Records.create(payload);
    submitted = true;
    updateBadge();
    Util.toast("提单成功，已生成出库记录");
    pushToCloud();
  }

  /** 编辑：将「已提单」解锁回「未提单」，允许调整（再提单生成新记录） */
  function unlockEdit() {
    submitted = false;
    updateBadge();
    Util.toast("已解锁，可调整明细后再次提单（将生成新记录）");
  }

  /** 清空：清客户/经办人/备注/明细并重置「未提单」 */
  function clearAll() {
    items = [];
    submitted = false;
    els.customer.value = "";
    els.picker.value = "管理员";
    els.remark.value = "";
    updateBadge();
    renderItems();
    Util.toast("已清空");
  }

  function updateBadge() {
    els.badge.textContent = submitted ? "已提单" : "未提单";
    els.badge.className = "pos-badge" + (submitted ? " ok" : "");
  }

  function pushToCloud() {
    if (!Cloud.hasToken()) return;
    Cloud.pushAllLocal().then(function (res) {
      State.lastSync = new Date();
      window.App.Views.app.setSyncStatus(res.fail > 0 ? "部分同步失败" : "就绪", res.fail > 0);
    }).catch(function () {
      window.App.Views.app.setSyncStatus("云端同步失败", true);
    });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.outpos = { render: render };
})();
