/**
 * borrow.js — 先借后还模块
 * 从出库记录「借出」转入 → 借出中列表（库存保持扣减）→ 归还时输入数量：
 *   - 归还>0 的货品 → 生成入库记录（type:"in", affectsStock:true）加回库存，推钉钉「新入库登记」；
 *   - 差额>0 的货品 → 生成差额出库记录（type:"out", status:"pending", affectsStock:false 不重复扣），
 *     以「未提单」出现在出库记录页，推钉钉「新出库登记」；
 *   - 全部还清 → 原单标记 borrowDone，移入「已完成」tab 保留回查。
 * 纯追加字段：borrowed / borrowReturned / borrowDone / fromBorrowId，不破坏既有 schema。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var State = window.App.State;
  var Records = window.App.Records;
  var Cloud = window.App.Cloud;

  var container = null;
  var listBox = null;
  var activeTab = "ongoing";   // "ongoing"（借出中）| "done"（已完成）

  /**
   * 弹窗内异步提交防重：把按钮置忙并返回解锁函数。
   * 借出转入 / 归还都要 await 云端推送，期间连点会重复写记录，必须上锁。
   * @param {Element} btn
   * @returns {{locked:boolean, unlock:function}} locked=true 表示已在提交中，调用方应直接 return
   */
  function lockBtn(btn) {
    if (!btn) return { locked: false, unlock: function () {} };
    if (btn.dataset.busy === "1") return { locked: true, unlock: function () {} };
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.classList.add("loading");
    btn.setAttribute("aria-busy", "true");
    return {
      locked: false,
      unlock: function () {
        if (!btn.isConnected) return;   // 弹窗已关闭，无需还原
        btn.dataset.busy = "0";
        btn.disabled = false;
        btn.classList.remove("loading");
        btn.setAttribute("aria-busy", "false");
      }
    };
  }

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>先借后还 <span class="badge" id="borrowCount">0 单</span></h2>' +
        '<div class="actions rec-actions">' +
          '<button type="button" class="btn sm" id="borrowAdd">&#43; 添加借出</button>' +
          '<button type="button" class="btn ghost sm" id="borrowSync">&#128260; 立即同步</button>' +
        '</div>' +
        '<div class="pickups-tabs">' +
          '<button type="button" class="pickups-tab active" data-tab="ongoing">借出中</button>' +
          '<button type="button" class="pickups-tab" data-tab="done">已完成</button>' +
        '</div>' +
        '<div id="borrowListBox"></div>' +
      '</div>';

    Util.$("borrowAdd").addEventListener("click", openAddBorrow);
    Util.$("borrowSync").addEventListener("click", doSync);
    listBox = Util.$("borrowListBox");
    bindTabs();
    listBox.addEventListener("click", onListClick);
    renderList();
  }

  /** 可转入先借后还的出库记录：出库单 + affectsStock===true + 未转入 + 非差额单；未提单优先，再按时间倒序 */
  function eligibleOutRecords() {
    return State.list.filter(function (r) {
      if ((r.type || "out") === "in") return false;   // 仅出库
      if (r.affectsStock !== true) return false;      // 不参与库存（差额单/旧快照）不可借出
      if (r.borrowed === true) return false;          // 已转入
      if (r.fromBorrowId) return false;               // 差额单/归还单不可再转
      return true;
    }).sort(function (a, b) {
      var pa = Records.getStatus(a) === "pending" ? 0 : 1;
      var pb = Records.getStatus(b) === "pending" ? 0 : 1;
      return pa - pb || String(b.time || "").localeCompare(String(a.time || ""));
    });
  }

  /** 借出记录（含借出中+已完成） */
  function borrowList() {
    return State.list.filter(function (r) { return r.borrowed === true; });
  }

  /** 每货品累计已还数量：{name: qty} */
  function returnedMap(r) {
    var map = {};
    (r.borrowReturned || []).forEach(function (it) {
      if (it && it.name) map[it.name] = (map[it.name] || 0) + (Number(it.qty) || 0);
    });
    return map;
  }

  /** 轻量字符串哈希（FNV-1a，转 36 进制），用于派生确定性 id */
  function simpleHash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /** 归还入库记录的确定性 id：ret-<借出单id>-<本次归还内容哈希>。
      同一笔归还（同借出单、同累计已还）在不同设备并发点归还 → 算出的 id 相同 → 合并按 id 只留一条 → 库存只加一次；
      不同次（部分）归还累计已还不同 → id 不同 → 各自累加，不互相覆盖。仍保留 fromBorrowId 用于追溯。 */
  function returnRecordId(r, newRet) {
    return "ret-" + r.id + "-" + simpleHash(JSON.stringify({ b: r.id, ret: newRet }));
  }

  /** 每货品剩余应还：[{name, qty}]，qty>0 才保留 */
  function remainingItems(r) {
    var ret = returnedMap(r);
    return (r.items || []).map(function (it) {
      return { name: it.name, qty: Math.max(0, (Number(it.qty) || 0) - (ret[it.name] || 0)) };
    }).filter(function (x) { return x.qty > 0; });
  }

  function isDone(r) { return r.borrowDone === true || remainingItems(r).length === 0; }

  /** 是否已有归还记录（有归还则不可退回出库记录页，避免库存账目错乱） */
  function hasReturned(r) {
    return Object.keys(returnedMap(r)).length > 0;
  }

  function renderList() {
    if (!listBox) return;
    var all = borrowList();
    var ongoing = all.filter(function (r) { return !isDone(r); });
    var done = all.filter(function (r) { return isDone(r); });
    var shown = activeTab === "done" ? done : ongoing;
    Util.$("borrowCount").textContent = ongoing.length + " 单";
    if (!shown.length) {
      listBox.innerHTML = '<div class="empty">' +
        (activeTab === "done" ? "暂无已结清的借出记录。" : "暂无借出中的记录，点「添加借出」从出库记录转入。") + '</div>';
      return;
    }
    var html = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>序号</th><th>时间</th><th>领取人</th><th>部门</th><th>货品明细（借出｜已还｜剩余）</th><th>备注</th><th>状态</th><th>操作</th>' +
      '</tr></thead><tbody>';
    shown.forEach(function (r, i) {
      var ret = returnedMap(r);
      var lines = (r.items || []).map(function (it) {
        var out = Number(it.qty) || 0;
        var back = ret[it.name] || 0;
        var rem = Math.max(0, out - back);
        return '<div class="item-line">' + Util.esc(it.name) + '：借出' + out + '｜已还' + back + '｜剩余' + rem + '</div>';
      }).join("");
      // 备注列：超长截断（>24 字加省略号），鼠标悬停看完整；空时显示「-」
      var noteRaw = String(r.note || '').trim();
      var noteShort = noteRaw
        ? (noteRaw.length > 24 ? noteRaw.slice(0, 24) + '…' : noteRaw)
        : '-';
      html += '<tr>' +
        '<td><div>' + (shown.length - i) + '</div></td>' +
        '<td>' + Util.esc(r.time || "-") + '</td>' +
        '<td>' + Util.esc(r.picker || "-") + '</td>' +
        '<td>' + Util.esc(r.dept || "-") + '</td>' +
        '<td class="items-cell">' + lines + '</td>' +
        '<td class="note-cell" title="' + Util.esc(noteRaw || '无备注') + '" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + Util.esc(noteShort) + '</td>' +
        '<td>' + (isDone(r)
          ? '<span class="status-pill submitted static"><span class="dot"></span>已完成</span>'
          : '<span class="status-pill pending static"><span class="dot"></span>借出中</span>') + '</td>' +
        '<td>' +
          (!isDone(r) ? '<button type="button" class="btn sm" data-act="return" data-id="' + r.id + '">归还</button> ' : '') +
          (!isDone(r) && !hasReturned(r) ? '<button type="button" class="btn ghost sm" data-act="unborrow" data-id="' + r.id + '">退回</button> ' : '') +
          '<button type="button" class="btn ghost sm" data-act="detail" data-id="' + r.id + '">详细</button>' +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    listBox.innerHTML = html;
  }

  /* ---------- 列表操作 ---------- */

  function onListClick(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    var id = btn.getAttribute("data-id");
    if (act === "return") openReturn(id);
    else if (act === "unborrow") doUnborrow(id);
    else if (act === "detail") showDetail(id);
  }

  /* ---------- 添加借出 ---------- */

  async function openAddBorrow() {
    var eligible = eligibleOutRecords();
    if (!eligible.length) { Util.toast("暂无可借出的出库记录", true); return; }
    var rows = eligible.map(function (r, i) {
      var st = Records.getStatus(r) === "pending" ? "未提单" : "已提单";
      var goods = (r.items || []).map(function (it) { return Util.esc(it.name) + "×" + it.qty; }).join("，");
      return '<tr>' +
        '<td><input type="checkbox" class="borrow-check" value="' + r.id + '" /></td>' +
        '<td>' + (eligible.length - i) + '</td>' +
        '<td>' + Util.esc(r.time || "-") + '</td>' +
        '<td>' + Util.esc(r.picker || "-") + '</td>' +
        '<td>' + st + '</td>' +
        '<td>' + Util.esc(r.dept || "-") + '</td>' +
        '<td class="items-cell">' + goods + '</td>' +
      '</tr>';
    }).join("");
    var body =
      '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th style="width:34px;"><input type="checkbox" id="borrowAll" /></th><th>序号</th><th>时间</th><th>领取人</th><th>状态</th><th>部门</th><th>货品</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="field" style="margin-top:14px">' +
        '<label for="borrowNoteInput">借出备注（选填，用于特殊情况说明，如：暂借5天/下周还等）</label>' +
        '<textarea id="borrowNoteInput" rows="2" maxlength="200" placeholder="例：暂借5天，预计 8/20 归还；或：先领用，待审批后补单" autocomplete="off" enterkeyhint="enter"></textarea>' +
      '</div>' +
      '<div class="modal-actions"><button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
      '<button type="button" class="btn sm" data-act="ok">确认借出</button></div>';
    UI.Modal.show("选择要转入先借后还的出库记录（未提单优先）", body, { width: "720px" });
    var mBody = UI.Modal.body();
    mBody.querySelector("#borrowAll").addEventListener("change", function () {
      mBody.querySelectorAll(".borrow-check").forEach(function (c) { c.checked = mBody.querySelector("#borrowAll").checked; });
    });
    mBody.querySelector('[data-act="cancel"]').onclick = function () { UI.Modal.hide(); };
    mBody.querySelector('[data-act="ok"]').onclick = async function () {
      var lk = lockBtn(this);
      if (lk.locked) return;                 // 连点二次直接吞掉
      try {
        var ids = Array.from(mBody.querySelectorAll(".borrow-check")).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        if (!ids.length) { Util.toast("请至少勾选一条记录", true); return; }
        var borrowNote = (mBody.querySelector('#borrowNoteInput').value || '').trim();
        var ok = await UI.confirmDialog("将所选 " + ids.length + " 条记录转入先借后还？\n转入后将从出库记录页隐藏，库存扣减保留。", "确认借出");
        if (!ok) return;
        UI.Modal.hide();
        var fail = 0;
        for (var i = 0; i < ids.length; i++) {
          var rec = Records.update(ids[i], { borrowed: true });
          if (rec) {
            // 借出备注非空时：附加到原 note（保留原备注，不覆盖；空则用「借出备注：xxx」起头）
            if (borrowNote) {
              var oldNote = String(rec.note || '').trim();
              var newNote = oldNote ? (oldNote + '；借出备注：' + borrowNote) : ('借出备注：' + borrowNote);
              var updated = Records.update(ids[i], { note: newNote });
              if (updated) rec = updated;
            }
            if (Cloud.hasToken()) {
              try { await Cloud.pushRecord(rec); } catch (e) { fail++; }
            }
          } else fail++;
        }
        renderList();
        Util.toast(fail ? "已转入 " + (ids.length - fail) + " 单（" + fail + " 条待补推）" : "已转入 " + ids.length + " 单");
        if (fail) window.App.Views.app.setSyncStatus("部分转入待补推", true);
        else window.App.Views.app.setSyncStatus("已同步", false);
      } finally {
        lk.unlock();
      }
    };
  }

  /* ---------- 归还 ---------- */

  function openReturn(id) {
    var r = State.list.find(function (x) { return x.id === id; });
    if (!r) return;
    var ret = returnedMap(r);
    var rem = remainingItems(r);
    if (!rem.length) { Util.toast("该借出已全部归还", true); return; }
    var rows = rem.map(function (it) {
      var orig = (r.items || []).find(function (x) { return x.name === it.name; });
      var outQty = orig ? (Number(orig.qty) || 0) : 0;
      return '<tr>' +
        '<td>' + Util.esc(it.name) + '</td>' +
        '<td>' + outQty + '</td>' +
        '<td>' + (ret[it.name] || 0) + '</td>' +
        '<td style="color:#E11D48;font-weight:600;">' + it.qty + '</td>' +
        '<td><input type="number" class="return-input" data-name="' + Util.esc(it.name) + '" min="0" max="' + it.qty + '" step="any" value="0" inputmode="decimal" enterkeyhint="done" aria-label="' + Util.esc(it.name) + ' 本次归还数量（最多 ' + it.qty + '）" style="width:96px;" /></td>' +
      '</tr>';
    }).join("");
    var body =
      '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>货品</th><th>借出</th><th>已还</th><th>剩余应还</th><th>本次归还</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="hint" style="margin-top:8px;">未归还的差额将自动生成「未提单」出库记录。</div>' +
      '<div class="modal-actions"><button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
      '<button type="button" class="btn sm" data-act="ok">确认归还</button></div>';
    UI.Modal.show("归还 — " + (r.picker || "借出单"), body, { width: "640px" });
    var mBody = UI.Modal.body();
    mBody.querySelector('[data-act="cancel"]').onclick = function () { UI.Modal.hide(); };
    mBody.querySelector('[data-act="ok"]').onclick = async function () {
      var lk = lockBtn(this);
      if (lk.locked) return;                 // 连点二次直接吞掉
      try {
        var inputs = Array.from(mBody.querySelectorAll(".return-input"));
        var returns = [];
        var badNames = [];
        var firstBad = null;
        inputs.forEach(function (inp) {
          inp.removeAttribute("aria-invalid");
          inp.style.borderColor = "";
          var v = Number(inp.value);
          if (!inp.value || isNaN(v)) v = 0;
          var max = Number(inp.max) || 0;
          if (v < 0 || v > max) {
            // 逐格标红，直接告诉用户是哪一行超了，替代笼统的一句 toast
            badNames.push(inp.getAttribute("data-name") + "（最多 " + max + "）");
            inp.setAttribute("aria-invalid", "true");
            inp.style.borderColor = "#E11D48";
            if (!firstBad) firstBad = inp;
            return;
          }
          if (v > 0) returns.push({ name: inp.getAttribute("data-name"), qty: v });
        });
        if (badNames.length) {
          Util.toast("归还数量超出剩余应还：" + badNames.join("、"), true);
          if (firstBad) { try { firstBad.focus(); firstBad.select(); } catch (e) {} }
          return;
        }
        if (!returns.length) { Util.toast("请至少归还一项", true); return; }
        var ok = await UI.confirmDialog("确认归还？系统将自动处理差额并生成未提单出库记录。", "确认归还");
        if (!ok) return;
        UI.Modal.hide();
        await doReturn(r, returns);
      } finally {
        lk.unlock();
      }
    };
  }

  /** 归还核心：生成归还入库 + 差额出库 + 更新原单（本地保存 + 云端推送，全部幂等） */
  async function doReturn(r, returns) {
    var ret = returnedMap(r);
    // 2) 先计算新累计已还 + 剩余（供下方归还入库记录生成确定性 id 使用）
    var newRet = {};
    Object.keys(ret).forEach(function (k) { newRet[k] = ret[k]; });
    returns.forEach(function (x) { newRet[x.name] = (newRet[x.name] || 0) + x.qty; });
    // 1) 归还>0 → 入库记录（加回库存）。
    //    用确定性 id（ret-<借出单id>-<本次归还内容哈希>）：同一笔并发归还多次提交 → 同 id → 合并只留一条 → 库存只加一次；
    //    不同次部分归还内容不同 → 不同 id → 各自累加。仍保留 fromBorrowId 用于追溯，原单标记逻辑不变。
    var inRec = null;
    if (returns.length) {
      inRec = Records.create({
        id: returnRecordId(r, newRet),
        type: "in", affectsStock: true, purpose: "先借后还归还",
        note: "归还借出单 " + r.id, time: Util.nowLocal(),
        picker: r.picker || "", dept: r.dept || "",
        items: returns.map(function (x) { return { name: x.name, qty: x.qty }; }),
        fromBorrowId: r.id
      });
    }
    var borrowReturned = Object.keys(newRet).map(function (k) { return { name: k, qty: newRet[k] }; });
    var diffItems = (r.items || []).map(function (it) {
      return { name: it.name, qty: Math.max(0, (Number(it.qty) || 0) - (newRet[it.name] || 0)) };
    }).filter(function (x) { return x.qty > 0; });
    // 3) 差额>0 → 差额出库记录（未提单，affectsStock:false 不重复扣）
    var diffRec = null;
    if (diffItems.length) {
      diffRec = Records.create({
        type: "out", status: "pending", affectsStock: false, fromBorrowId: r.id,
        time: Util.nowLocal(), picker: r.picker || "", dept: r.dept || "",
        purpose: r.purpose || "", entity: r.entity || "",
        note: ((r.note || "").trim() ? (r.note + "；") : "") + "先借后还差额单（原 " + r.id + "）",
        items: diffItems.map(function (x) { return { name: x.name, qty: x.qty }; })
      });
    }
    // 4) 更新原单
    var done = diffItems.length === 0;
    var updated = Records.update(r.id, { borrowReturned: borrowReturned, borrowDone: done });
    renderList();
    Util.toast(done ? "已全部归还，借出结清" : "已归还，剩余差额已生成未提单出库记录");
    // 5) 云端推送
    if (!Cloud.hasToken()) return;
    var fail = 0;
    if (inRec) { try { await Cloud.pushRecord(inRec); } catch (e) { fail++; } }
    if (diffRec) { try { await Cloud.pushRecord(diffRec); } catch (e) { fail++; } }
    if (updated) { try { await Cloud.pushRecord(updated); } catch (e) { fail++; } }
    if (fail) window.App.Views.app.setSyncStatus("部分归还同步待补推", true);
    else window.App.Views.app.setSyncStatus("已同步", false);
  }

  /** 退回出库记录：仅未归还的借出可退回（有归还会打乱库存账目，禁止）。退回后库存扣减保留、未提单状态照旧。 */
  async function doUnborrow(id) {
    var r = State.list.find(function (x) { return x.id === id; });
    if (!r) return;
    if (isDone(r) || hasReturned(r)) {
      Util.toast("该借出已归还/结清，不可退回出库记录", true);
      return;
    }
    var ok = await UI.confirmDialog("将这笔借出退回出库记录页？\n退回后恢复显示为出库记录（库存扣减保留，不另行改动）。", "退回出库记录");
    if (!ok) return;
    var updated = Records.update(id, { borrowed: false, borrowReturned: [], borrowDone: false });
    if (!updated) { Util.toast("记录不存在", true); return; }
    renderList();
    Util.toast("已退回出库记录页");
    if (!Cloud.hasToken()) return;
    try { await Cloud.pushRecord(updated); window.App.Views.app.setSyncStatus("已同步", false); }
    catch (e) { window.App.Views.app.setSyncStatus("退回同步待补推", true); }
  }

  /* ---------- 详情 / 同步 / tab ---------- */

  function showDetail(id) {
    var r = State.list.find(function (x) { return x.id === id; });
    if (!r) return;
    var ret = returnedMap(r);
    var lines = (r.items || []).map(function (it) {
      return '<div class="detail-item"><span>' + Util.esc(it.name) + '</span>' +
        '<span style="color:var(--muted);">借出 ' + (Number(it.qty) || 0) + '｜已还 ' + (ret[it.name] || 0) +
        '｜剩余 ' + Math.max(0, (Number(it.qty) || 0) - (ret[it.name] || 0)) + '</span></div>';
    }).join("");
    var rows = "";
    rows += '<div class="detail-row"><span class="k">状态</span><span class="v">' +
      (isDone(r) ? '<span class="status-pill submitted static"><span class="dot"></span>已完成</span>'
                 : '<span class="status-pill pending static"><span class="dot"></span>借出中</span>') + '</span></div>';
    rows += '<div class="detail-row"><span class="k">出库时间</span><span class="v">' + Util.esc(r.time || "-") + '</span></div>';
    rows += '<div class="detail-row"><span class="k">领取人</span><span class="v">' + Util.esc(r.picker || "-") + '</span></div>';
    rows += '<div class="detail-row"><span class="k">部门/客户</span><span class="v">' + Util.esc(r.dept || "-") + '</span></div>';
    if (r.entity) rows += '<div class="detail-row"><span class="k">出货仓库单位</span><span class="v">' + Util.esc(r.entity) + '</span></div>';
    rows += '<div class="detail-row"><span class="k">用途</span><span class="v">' + Util.esc(r.purpose || "-") + '</span></div>';
    if (r.note) rows += '<div class="detail-row"><span class="k">备注</span><span class="v">' + Util.esc(r.note) + '</span></div>';
    rows += '<div class="detail-row"><span class="k">货品归还</span><span class="v detail-items">' + (lines || "-") + '</span></div>';
    UI.Modal.show("借出详情", rows, { width: "560px" });
  }

  function doSync() {
    if (!Cloud.hasToken()) { Util.toast("未配置云端令牌，无法同步", true); return; }
    Util.toast("正在同步…");
    Cloud.syncPull({ onStatus: function (text, isErr) {
      window.App.Views.app.setSyncStatus(text, isErr);
    } }).then(function () { renderList(); });
  }

  function bindTabs() {
    var tabs = container.querySelectorAll(".pickups-tab");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        activeTab = t.getAttribute("data-tab");
        tabs.forEach(function (x) { x.classList.toggle("active", x === t); });
        renderList();
      });
    });
  }

  function refresh() { if (container && listBox) renderList(); }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.borrow = { render: render, refresh: refresh, doSync: doSync };
})();
