/**
 * memos.js — 备忘录模块（登记表单 + 未完成/已完成 tab 列表）
 * 添加：输入待做事项 → Memos.create（默认 done:false）→ 推送云端 data/memos/<id>.json。
 * 状态：done=false 未完成（红徽章，可点击标记为已完成）；done=true 已完成（绿徽章静态）。
 * 删除：本地删除 + 云端直接删文件（不带墓碑，流程性数据不做删除同步，与待取货一致）。
 * 提交/变更均同步云端（无 token 存本机，下次「立即同步」自动上传）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var State = window.App.State;
  var Memos = window.App.Memos;
  var Cloud = window.App.Cloud;

  var container = null;
  var listBox = null;
  var textInput = null;
  var activeTab = "todo";   // "todo"（未完成）| "done"（已完成）

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>添加待做事项</h2>' +
        '<div class="field">' +
          '<label>待做事项<span class="req">*</span></label>' +
          '<textarea id="memoText" rows="2" placeholder="例如：补充面膜 5片装库存…"></textarea>' +
          '<div class="hint">按 Ctrl + Enter 快速提交</div>' +
        '</div>' +
        '<div class="actions">' +
          '<button type="button" class="btn" id="memoAdd">添加</button>' +
          '<button type="button" class="btn ghost" id="memoReset">清空</button>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>备忘录 <span class="badge" id="memoCount">未完成 0 项</span></h2>' +
        '<div class="actions rec-actions">' +
          '<button type="button" class="btn ghost sm" id="memoSync">&#128260; 立即同步</button>' +
        '</div>' +
        '<div class="pickups-tabs">' +
          '<button type="button" class="pickups-tab active" data-tab="todo">未完成</button>' +
          '<button type="button" class="pickups-tab" data-tab="done">已完成</button>' +
        '</div>' +
        '<div id="memoListBox"></div>' +
      '</div>';

    textInput = Util.$("memoText");
    Util.$("memoAdd").addEventListener("click", submit);
    Util.$("memoReset").addEventListener("click", function () { textInput.value = ""; textInput.focus(); });
    Util.$("memoSync").addEventListener("click", doSync);
    textInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    });
    listBox = Util.$("memoListBox");

    bindTabs();
    listBox.addEventListener("click", onListClick);
    renderList();
  }

  /* ---------- 添加 ---------- */

  function submit() {
    var text = textInput.value.trim();
    if (!text) { Util.toast("请输入待做事项", true); textInput.focus(); return; }
    var memo = Memos.create({ text: text, time: Util.nowLocal() });
    textInput.value = "";
    renderList();
    if (Cloud.hasToken()) {
      Util.toast("已添加，正在同步到云端…");
      Cloud.pushMemo(memo).then(function () {
        window.App.Views.app.setSyncStatus("已同步", false);
      }).catch(function () {
        window.App.Views.app.setSyncStatus("云端同步失败（已存本机）", true);
      });
    } else {
      Util.toast("已添加（已存本机）");
    }
  }

  /* ---------- 列表渲染 ---------- */

  function renderList() {
    if (!listBox) return;
    var list = State.memos;
    var todo = list.filter(function (m) { return m.done !== true; });
    var done = list.filter(function (m) { return m.done === true; });
    var shown = activeTab === "done" ? done : todo;
    Util.$("memoCount").textContent = "未完成 " + todo.length + " 项";
    if (!shown.length) {
      listBox.innerHTML = '<div class="empty">' +
        (activeTab === "done" ? "暂无已完成事项。" : "暂无待做事项，请先在上方添加。") +
        '</div>';
      return;
    }
    var html = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>序号</th><th>事项内容</th><th>添加时间</th><th>状态</th><th>操作</th>' +
      '</tr></thead><tbody>';
    shown.forEach(function (m, i) {
      var textCls = m.done === true ? ' class="memo-done"' : "";
      html += '<tr>' +
        '<td><div>' + (shown.length - i) + '</div></td>' +
        '<td><div' + textCls + '>' + Util.esc(m.text || "") + '</div></td>' +
        '<td>' + Util.esc(String(m.time || "").replace("T", " ")) + '</td>' +
        '<td>' + statusPill(m) + '</td>' +
        '<td><button type="button" class="btn danger sm" data-act="del" data-id="' + m.id + '">删除</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    listBox.innerHTML = html;
  }

  /** 状态徽章：未完成=红（可点击标记已完成）；已完成=绿静态不可点 */
  function statusPill(m) {
    if (m.done === true) {
      return '<span class="status-pill submitted static"><span class="dot"></span>已完成</span>';
    }
    return '<button type="button" class="status-pill pending" data-act="done" data-id="' + m.id + '"><span class="dot"></span>未完成</button>';
  }

  /* ---------- 列表操作 ---------- */

  function onListClick(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    var id = btn.getAttribute("data-id");
    if (act === "done") markDone(id);
    else if (act === "del") doDel(id);
  }

  /** 标记已完成：done false→true，本地保存 + 推送云端 */
  async function markDone(id) {
    var memo = State.memos.find(function (x) { return x.id === id; });
    if (!memo) return;
    if (memo.done === true) return;
    var ok = await UI.confirmDialog("标记为已完成？", "完成事项");
    if (!ok) return;
    var updated = Memos.update(id, { done: true });
    if (!updated) { Util.toast("记录不存在", true); return; }
    renderList();
    Util.toast("已标记为完成");
    if (Cloud.hasToken()) {
      Cloud.pushMemo(updated).then(function () {
        window.App.Views.app.setSyncStatus("已同步", false);
      }).catch(function () {
        window.App.Views.app.setSyncStatus("云端同步失败", true);
      });
    }
  }

  /** 删除备忘录：本地删除 + 云端直接删文件（不带墓碑） */
  async function doDel(id) {
    var memo = State.memos.find(function (x) { return x.id === id; });
    if (!memo) return;
    var res = await UI.promptDialog("删除该备忘录？请填写原因：", "例如：事项已过期/不再需要…", "删除备忘录", "确认删除");
    if (!res.ok) return;
    Memos.remove(id);
    renderList();
    Util.toast("已删除备忘录");
    if (Cloud.hasToken()) {
      try { await Cloud.delMemo(id); }
      catch (e) {
        window.App.Views.app.setSyncStatus("云端删除失败（已存本机）", true);
      }
    }
  }

  /* ---------- 立即同步 + tab 切换 ---------- */

  function doSync() {
    if (!Cloud.hasToken()) { Util.toast("未配置云端令牌，无法同步", true); return; }
    Util.toast("正在同步…");
    Cloud.syncPull({ onStatus: function (text, isErr) {
      window.App.Views.app.setSyncStatus(text, isErr);
    } }).then(function () {
      renderList();
      // 确保本机未推送的备忘录全部上传（幂等，失败不影响）
      Cloud.pushAllMemos(State.memos).then(function (res) {
        if (res.fail > 0) window.App.Views.app.setSyncStatus("部分备忘录推送失败（" + res.fail + "）", true);
      });
    });
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

  /** 云端同步后刷新（重建列表） */
  function refresh() {
    if (container && listBox) renderList();
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.memos = { render: render, refresh: refresh, doSync: doSync };
})();
