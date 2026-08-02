/**
 * auth.js — 认证：密码 1111 / 连续 5 次失败锁定 60 秒（前端计时，防误触非安全）/ 记住登录 7 天
 */
(function () {
  'use strict';

  var Config = window.App.Config;
  var Store = window.App.Store;

  var failCount = 0;   // 内存计数
  var lockUntil = 0;   // 锁定截止时间戳

  function remainingLock() {
    return Math.max(0, lockUntil - Date.now());
  }

  /**
   * 验证页登录
   * @param {string} pw 密码
   * @param {boolean} remember 记住登录（写入 outbound_auth{expires}，7 天）
   * @returns {{ok: boolean, err?: string}}
   */
  function login(pw, remember) {
    var remain = remainingLock();
    if (remain > 0) {
      return { ok: false, err: "尝试次数过多，请 " + Math.ceil(remain / 1000) + " 秒后再试" };
    }
    if (pw === Config.PASSWORD) {
      failCount = 0;
      if (remember) {
        Store.saveAuth({ expires: Date.now() + Config.AUTH_TTL_MS });
      } else {
        Store.clearAuth();
      }
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

  /** 是否已登录（记住登录未过期） */
  function isAuthed() {
    var auth = Store.loadAuth();
    return !!(auth && auth.expires && auth.expires > Date.now());
  }

  function logout() {
    Store.clearAuth();
  }

  /** 管理操作密码校验（直接比对，不计入锁定） */
  function checkPw(pw) {
    return pw === Config.PASSWORD;
  }

  window.App = window.App || {};
  window.App.Auth = {
    login: login,
    isAuthed: isAuthed,
    logout: logout,
    checkPw: checkPw,
    remainingLock: remainingLock
  };
})();
