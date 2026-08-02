/**
 * auth.js — 认证：密码 1111 / 连续 5 次失败锁定 60 秒（前端计时，防误触非安全）
 * 会话级内存标志：不写 localStorage、不记住登录；刷新页面即失效。
 */
(function () {
  'use strict';

  var Config = window.App.Config;

  var sessionAuthed = false;   // 会话级内存标志
  var failCount = 0;           // 内存计数
  var lockUntil = 0;           // 锁定截止时间戳

  function remainingLock() {
    return Math.max(0, lockUntil - Date.now());
  }

  /**
   * 登录（会话级）：成功仅置内存标志
   * @param {string} pw 密码
   * @returns {{ok: boolean, err?: string}}
   */
  function login(pw) {
    var remain = remainingLock();
    if (remain > 0) {
      return { ok: false, err: "尝试次数过多，请 " + Math.ceil(remain / 1000) + " 秒后再试" };
    }
    if (pw === Config.PASSWORD) {
      failCount = 0;
      sessionAuthed = true;
      return { ok: true };
    }
    failCount++;
    if (failCount >= Config.MAX_PW_FAILS) {
      lockUntil = Date.now() + Config.PW_LOCK_MS;
      failCount = 0;
      return { ok: false, err: "密码错误次数过多，已锁定 60 秒" };
    }
    return { ok: false, err: "密码错误，请重试（剩余 " + (Config.MAX_PW_FAILS - failCount) + " 次机会）" };
  }

  /** 是否已登录（仅会话内存标志，不再读取 localStorage） */
  function isAuthed() {
    return sessionAuthed;
  }

  function logout() {
    sessionAuthed = false;
  }

  window.App = window.App || {};
  window.App.Auth = {
    login: login,
    isAuthed: isAuthed,
    logout: logout,
    remainingLock: remainingLock
  };
})();
