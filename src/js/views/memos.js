/**
 * memos.js — 备忘录模块（登记表单 + 未完成/已完成 tab 列表 + 每条备忘独立提醒）
 * 添加：输入待做事项（可选填提醒时间）→ Memos.create（默认 done:false，remindAt 可选）→ 推送云端。
 * 提醒：每条备忘各自绑定 remindAt（"YYYY-MM-DDTHH:mm" 北京时间本地表示，空=不提醒）；
 *       到点未完成由 GitHub Action 定时任务推送钉钉，推送后写回 reminded:true 防重复；
 *       列表每行提供「⏰ 设提醒/改提醒」按钮（可清空提醒）。
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
  var remindInput = null;   // 添加区「提醒时间（可选）」datetime-local
  var photos = null;        // 添加区照片上传组件（可选，多张）
  var activeTab = "todo";   // "todo"（未完成）| "done"（已完成）
  var submitting = false;   // 提交互斥锁：防止连点/连按 Ctrl+Enter 造成重复添加

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>添加待做事项</h2>' +
        '<div class="field">' +
          '<label for="memoText">待做事项<span class="req">*</span></label>' +
          '<textarea id="memoText" rows="2" maxlength="500" placeholder="例如：补充面膜 5片装库存…" autocomplete="off" enterkeyhint="enter" aria-label="待做事项"></textarea>' +
          '<div class="hint">按 Ctrl + Enter 快速提交</div>' +
        '</div>' +
        '<div class="field">' +
          '<label>照片（可选）</label>' +
          '<div id="memoPhotoUpload"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label for="memoRemindAt">提醒时间（可选）</label>' +
          '<input type="datetime-local" id="memoRemindAt" step="60" aria-label="提醒时间（可选）" />' +
          '<div class="hint">到点未完成将推送钉钉，推送后失效；留空则不提醒</div>' +
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
    remindInput = Util.$("memoRemindAt");
    photos = new UI.PhotoUpload({});
    photos.attach(Util.$("memoPhotoUpload"));
    Util.$("memoAdd").addEventListener("click", submit);
    Util.$("memoReset").addEventListener("click", function () {
      UI.clearFieldErrors((textInput.closest && textInput.closest(".card")) || document);
      textInput.value = "";
      remindInput.value = "";
      photos.setPhotos([]);
      textInput.focus();
    });
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

  /** remindAt 是否合法格式 "YYYY-MM-DDTHH:MM"（datetime-local 原生输出格式，step=60 无秒） */
  function isRemindAtValid(v) {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(v || "")) &&
      !isNaN(new Date(String(v)).getTime());
  }

  /** 提醒时间是否已到点（当前时刻 ≥ remindAt；用于列表展示样式区分） */
  function isRemindDue(v) {
    if (!v) return false;
    var t = new Date(String(v)).getTime();
    return !isNaN(t) && t <= Date.now();
  }

  /** 切换「添加」按钮加载态 */
  function setSubmitting(on) {
    submitting = !!on;
    var btn = Util.$("memoAdd");
    if (!btn) return;
    btn.disabled = !!on;
    btn.classList.toggle("loading", !!on);
    btn.setAttribute("aria-busy", on ? "true" : "false");
  }

  function submit() {
    if (submitting) return;   // 连点二次直接吞掉（Ctrl+Enter 也走这里）

    var text = textInput.value.trim();
    var remindAt = (remindInput && remindInput.value) || "";

    // 一次性收集全部问题，字段级标红 + 滚动定位，替代逐条 toast
    var errs = [];
    if (!text) errs.push({ el: textInput, msg: "请输入待做事项" });
    if (remindAt) {
      if (!isRemindAtValid(remindAt)) {
        errs.push({ el: remindInput, msg: "请选择有效的提醒时间" });
      } else if (new Date(remindAt).getTime() <= Date.now() + 60 * 1000) {
        // 必须晚于当前北京时间（留 1 分钟缓冲，避免保存后立即被 cron 命中）
        errs.push({ el: remindInput, msg: "提醒时间必须为未来（至少 1 分钟后）" });
      }
    }
    var scope = (textInput.closest && textInput.closest(".card")) || document;
    if (!UI.reportFieldErrors(errs, scope)) return;

    setSubmitting(true);
    // 设置提醒时间时顺带请求系统通知授权（在用户手势内调用，浏览器才允许）
    if (remindAt && window.App.Views.app) window.App.Views.app.requestMemoNotification();
    var memo = Memos.create({
      text: text,
      time: Util.nowLocal(),
      remindAt: remindAt,
      photos: photos.getPhotos()      // 可选：本地照片 dataURL（上传成功后写回 photoUrls）
    });
    textInput.value = "";
    remindInput.value = "";
    photos.setPhotos([]);
    renderList();
    if (Cloud.hasToken()) {
      Util.toast("已添加，正在同步到云端…");
      // submitPush 是 async，无论成功/失败都要解锁，否则「添加」按钮会永久禁用
      submitPush(memo)["catch"](function () {})["finally"](function () { setSubmitting(false); });
    } else {
      Util.toast("已添加（已存本机）");
      setSubmitting(false);
    }
  }

  /** 异步推送：先上传照片并写回 photoUrls（跨设备可见），再推备忘录本体。
      照片失败不静默：toast 提示 + 入补传队列，dataURL 保留在 memo.photos 不丢。 */
  async function submitPush(memo) {
    try {
      if (memo.photos && memo.photos.length) {
        if (Cloud.getRate && Cloud.getRate().low) {
          Util.toast("⚠️ API 配额紧张，照片可能上传较慢或失败；失败可到「云同步」页补传", true);
        }
        var r = await Cloud.pushPhotosDetailed(memo);
        if (r.urls && r.urls.length) {
          var updated = Memos.update(memo.id, { photoUrls: r.urls });
          if (updated) memo = updated;
        }
        if (r.failedIndexes && r.failedIndexes.length) {
          Cloud.markPhotoPending(memo.id, r.failedIndexes);
          var names = r.failedIndexes.map(function (i) { return "第 " + (i + 1) + " 张"; }).join("、");
          Util.toast("⚠️ 照片 " + names + " 上传失败（弱网/配额），已存本机，可到「云同步」页补传", true);
        }
      }
    } catch (e) { /* 照片上传异常不阻塞备忘录本体推送 */ }
    Cloud.pushMemo(memo).then(function () {
      window.App.Views.app.setSyncStatus("已同步", false);
    }).catch(function () {
      window.App.Views.app.setSyncStatus("云端同步失败（已存本机）", true);
    });
  }

  /* ---------- 列表渲染 ---------- */

  /** 提醒时间列：有 remindAt 显示 "⏰ YYYY-MM-DD HH:MM"，已到点样式区分；无则占位 */
  function remindCell(m) {
    if (!m.remindAt) return '<span style="color:var(--muted);">—</span>';
    var due = isRemindDue(m.remindAt);
    return '<span class="memo-remind' + (due ? " due" : "") + '">⏰ ' +
      Util.esc(String(m.remindAt).replace("T", " ")) + '</span>';
  }

  /** 备忘录照片缩略图：photoUrls（云端 URL）优先，无则用本地 photos（base64）；最多 4 张 */
  function memoPhotosHtml(m) {
    var urls = (m.photoUrls && m.photoUrls.length) ? m.photoUrls : (m.photos || []);
    if (!urls.length) return "";
    return '<div class="photos-cell">' + urls.slice(0, 4).map(function (src, pi) {
      return '<img class="mini-photo" src="' + src + '" data-act="photo" data-src="' + src + '" alt="照片' + (pi + 1) + '" />';
    }).join("") +
      (urls.length > 4 ? '<span class="badge">+' + (urls.length - 4) + '</span>' : "") +
      '</div>';
  }

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
      '<th>序号</th><th>事项内容</th><th>添加时间</th><th>提醒时间</th><th>状态</th><th>操作</th>' +
      '</tr></thead><tbody>';
    shown.forEach(function (m, i) {
      var textCls = m.done === true ? ' class="memo-done"' : "";
      var remindedBadge = m.reminded === true ? ' <span class="memo-reminded-badge">已提醒</span>' : "";
      html += '<tr>' +
        '<td><div>' + (shown.length - i) + '</div></td>' +
        '<td><div' + textCls + '>' + Util.esc(m.text || "") + '</div>' + memoPhotosHtml(m) + '</td>' +
        '<td>' + Util.esc(String(m.time || "").replace("T", " ")) + '</td>' +
        '<td>' + remindCell(m) + '</td>' +
        '<td>' + statusPill(m) + remindedBadge + '</td>' +
        '<td>' +
          '<button type="button" class="btn ghost sm" data-act="remind" data-id="' + m.id + '">⏰ ' +
            (m.remindAt ? "改提醒" : "设提醒") + '</button> ' +
          '<button type="button" class="btn danger sm" data-act="del" data-id="' + m.id + '">删除</button>' +
        '</td>' +
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
    else if (act === "remind") setReminder(id);
    else if (act === "del") doDel(id);
    else if (act === "photo") UI.Modal.show("照片预览", '<img class="preview-img" src="' + btn.getAttribute("data-src") + '" alt="" />', { width: "fit-content" });
  }

  /** 设/改提醒弹窗：datetime-local（step=60）+ 清空/取消/保存；保存 → updateRemind + 推送云端 + 重建列表 */
  function setReminder(id) {
    var m = State.memos.find(function (x) { return x.id === id; });
    if (!m) return;
    var cur = m.remindAt || "";
    var body =
      '<div class="field">' +
        '<label>提醒时间（可选）</label>' +
        '<input type="datetime-local" id="memoRemindEdit" step="60" value="' + Util.esc(cur) + '" />' +
        '<div class="hint">到点未完成将推送钉钉，推送后失效；留空则不提醒</div>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn ghost sm" data-act="remind-clear">清空</button>' +
        '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
        '<button type="button" class="btn sm" data-act="ok">保存</button>' +
      '</div>';
    UI.Modal.show(m.remindAt ? "改提醒" : "设提醒", body, { width: "380px" });
    var mBody = UI.Modal.body();
    var input = mBody.querySelector("#memoRemindEdit");
    mBody.querySelector('[data-act="remind-clear"]').onclick = function () { input.value = ""; };
    mBody.querySelector('[data-act="cancel"]').onclick = function () { UI.Modal.hide(); };
    mBody.querySelector('[data-act="ok"]').onclick = function () {
      var v = input.value;
      if (v) {
        if (!isRemindAtValid(v)) { Util.toast("请选择有效的提醒时间", true); return; }
        if (new Date(v).getTime() <= Date.now() + 60 * 1000) { Util.toast("提醒时间必须为未来", true); return; }
      }
      var updated = Memos.updateRemind(id, v);
      if (!updated) { Util.toast("记录不存在", true); return; }
      UI.Modal.hide();
      renderList();
      Util.toast(v ? "已设提醒：" + String(v).replace("T", " ") : "已清除提醒");
      if (Cloud.hasToken()) {
        Cloud.pushMemo(updated).then(function () {
          window.App.Views.app.setSyncStatus("已同步", false);
        }).catch(function () {
          window.App.Views.app.setSyncStatus("云端同步失败", true);
        });
      }
    };
    setTimeout(function () { input.focus(); }, 50);
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
