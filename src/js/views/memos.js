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
  var Store = window.App.Store;

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
        '<h2>提醒设置</h2>' +
        '<div class="field">' +
          '<label>提醒时间（特定日期 + 时间，单次）</label>' +
          '<div class="reminder-row">' +
            '<input type="datetime-local" id="memoReminderAt" step="60" />' +
            '<span class="hint" id="memoReminderWeekday"></span>' +
            '<button type="button" class="btn" id="memoReminderSave">保存</button>' +
          '</div>' +
          '<div class="hint">到点提醒一次，推送后失效；留空表示不设置。</div>' +
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
    Util.$("memoReminderSave").addEventListener("click", saveReminder);
    Util.$("memoReminderAt").addEventListener("input", updateReminderWeekday);
    textInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    });
    listBox = Util.$("memoListBox");

    bindTabs();
    listBox.addEventListener("click", onListClick);
    renderReminderSettings();
    syncReminderFromCloud();
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

  /* ---------- 提醒设置（单次：特定日期 + 时间，到点推一次，推送后失效） ---------- */

  /** 星期映射：JS getDay() 0=周日 … 6=周六 */
  var WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

  /** reminderAt 是否合法格式 "YYYY-MM-DDTHH:MM"（datetime-local 原生输出格式） */
  function isReminderAtValid(v) {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(v || "")) &&
      !isNaN(new Date(String(v)).getTime());
  }

  /** 更新「（星期X）」提示：new Date(value).getDay() 0=日 … 6=六；无效/空则清空 */
  function updateReminderWeekday() {
    var hint = Util.$("memoReminderWeekday");
    if (!hint) return;
    var input = Util.$("memoReminderAt");
    var v = (input && input.value) || "";
    if (!isReminderAtValid(v)) { hint.textContent = ""; return; }
    hint.textContent = "（星期" + WEEKDAY_CN[new Date(v).getDay()] + "）";
  }

  /** 读取本地提醒配置并回填 datetime-local（留空表示未设置） */
  function renderReminderSettings() {
    var cfg = Store.loadMemoConfig();
    var input = Util.$("memoReminderAt");
    if (input) input.value = cfg.reminderAt || "";
    updateReminderWeekday();
  }

  /** 保存提醒时间：校验格式 + 必须为未来 → 写 localStorage + 有 token 时推云端 data/memos/config.json */
  function saveReminder() {
    var input = Util.$("memoReminderAt");
    var v = (input && input.value) || "";
    if (v && !isReminderAtValid(v)) { Util.toast("请选择有效的提醒时间", true); if (input) input.focus(); return; }
    if (v) {
      var t = new Date(v).getTime();
      // 必须晚于当前北京时间（留 1 分钟缓冲，避免保存后立即被 cron 命中）
      if (t <= Date.now() + 60 * 1000) { Util.toast("提醒时间必须为未来", true); if (input) input.focus(); return; }
    }
    Store.saveMemoConfig({ reminderAt: v });
    Util.toast(v ? "已保存提醒时间：" + v.replace("T", " ") : "已清除提醒（未设置）");
    if (Cloud.hasToken()) {
      Cloud.pushMemoConfig({ reminderAt: v }).then(function () {
        window.App.Views.app.setSyncStatus("已同步", false);
      }).catch(function () {
        window.App.Views.app.setSyncStatus("云端同步失败（已存本机）", true);
      });
    }
  }

  /** 从云端拉取提醒配置同步到本地（有 token 且云端有合法 reminderAt 时以云端为准；失败静默保留本地） */
  function syncReminderFromCloud() {
    if (!Cloud.hasToken()) return;
    Cloud.pullMemoConfig().then(function (obj) {
      if (!obj) return;
      var v = String(obj.reminderAt || "");
      var cur = Store.loadMemoConfig();
      if (cur.reminderAt !== v) {
        Store.saveMemoConfig({ reminderAt: v });
        var input = Util.$("memoReminderAt");
        if (input) input.value = v;  // datetime-local 原生格式与 reminderAt 完全一致，直接赋值
        updateReminderWeekday();
      }
    }).catch(function () { /* 拉取失败静默，保留本地配置 */ });
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
    } }).then(function (res) {
      renderList();
      // 同步失败时本机 State.memos 仍是旧值，若继续全量上传会用旧 done:false 覆盖云端已完成状态，
      // 因此失败必须跳过上传（避免跨设备完成状态回退）
      if (!res || !res.ok) { Util.toast("同步失败，未上传本机变更", true); return; }
      // 确保本机未推送的备忘录全部上传（幂等，失败不影响）
      Cloud.pushAllMemos(State.memos).then(function (r) {
        if (r.fail > 0) window.App.Views.app.setSyncStatus("部分备忘录推送失败（" + r.fail + "）", true);
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
