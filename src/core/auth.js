'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const DEFAULT_PASSWORD = 'admin';

/** 面板账号体系：scrypt 密码 + 内存会话 cookie，失败次数过多临时锁定。 */
class Auth {
  constructor({ config, logger }) {
    this.config = config.panel;
    this.log = logger;
    this.file = path.join(config.dataDir, 'users.json');
    this.users = this.readUsers();
    this.sessions = new Map();
    this.failures = new Map();
    this.bootstrap();
  }

  readUsers() {
    if (!fs.existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(raw.users) ? raw.users : [];
    } catch (err) {
      this.log.warn(`用户文件解析失败，忽略: ${err.message}`);
      return [];
    }
  }

  writeUsers() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, users: this.users }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  /**
   * 首次启动创建管理员：默认 admin/admin（FAN_ADMIN_PASSWORD / panel.adminPassword 可覆盖）。
   * 把 adminPassword 显式配置成空字符串表示不创建账号，面板退回无鉴权模式。
   * 用默认密码创建的账号会带上 mustChangePassword，登录后前端会提示改密。
   */
  bootstrap() {
    const password = this.config.adminPassword;
    if (password === undefined || password === null || password === '') return;
    const username = this.config.adminUser || 'admin';
    if (this.users.some((user) => user.username === username)) return;
    const weak = String(password).length < 6;
    const isDefault = String(password) === DEFAULT_PASSWORD || weak;
    this.upsert(username, password, { mustChangePassword: isDefault, allowWeak: true });
    if (isDefault) {
      this.log.warn(`已创建默认账号 ${username}/${DEFAULT_PASSWORD}，请登录后立即修改密码（设置 → 修改我的密码）`);
    } else {
      this.log.info(`已创建初始账号 ${username}`);
    }
  }

  /** 该账号是否还在使用需要修改的初始密码。 */
  needsPasswordChange(username) {
    const user = this.users.find((item) => item.username === username);
    return Boolean(user && user.mustChangePassword);
  }

  hasUsers() {
    return this.users.length > 0;
  }

  listUsers() {
    return this.users.map((user) => ({
      username: user.username,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      mustChangePassword: Boolean(user.mustChangePassword),
    }));
  }

  upsert(username, password, options = {}) {
    const name = String(username || '').trim();
    if (!name) throw Object.assign(new Error('用户名不能为空'), { statusCode: 400 });
    // 默认初始密码（admin）只有 5 位，bootstrap 时放行；用户自己设置的密码仍要求 6 位以上
    const minimum = options.allowWeak ? 1 : 6;
    if (String(password || '').length < minimum) throw Object.assign(new Error(`密码至少 ${minimum} 位`), { statusCode: 400 });

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    const now = new Date().toISOString();
    const existing = this.users.find((user) => user.username === name);
    // 改过密码就清掉「需修改」标记；有明确要求时也可以带上
    const mustChange = options.mustChangePassword === true;
    if (existing) {
      existing.salt = salt;
      existing.hash = hash;
      existing.updatedAt = now;
      existing.mustChangePassword = mustChange;
    } else {
      this.users.push({ username: name, salt, hash, createdAt: now, updatedAt: now, mustChangePassword: mustChange });
    }
    this.writeUsers();
    return name;
  }

  remove(username) {
    const before = this.users.length;
    this.users = this.users.filter((user) => user.username !== username);
    if (this.users.length === before) return false;
    this.writeUsers();
    for (const [token, session] of this.sessions) {
      if (session.username === username) this.sessions.delete(token);
    }
    return true;
  }

  verify(username, password) {
    const user = this.users.find((item) => item.username === username);
    if (!user) return false;
    const candidate = Buffer.from(hashPassword(password, user.salt), 'hex');
    const expected = Buffer.from(user.hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  }

  login(username, password, ip = '-') {
    const record = this.failures.get(ip);
    if (record && record.lockedUntil > Date.now()) {
      const seconds = Math.ceil((record.lockedUntil - Date.now()) / 1000);
      throw Object.assign(new Error(`尝试次数过多，请 ${seconds} 秒后再试`), { statusCode: 429 });
    }

    if (!this.verify(username, password)) {
      const fails = (record?.fails || 0) + 1;
      this.failures.set(ip, { fails, lockedUntil: fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      this.log.warn(`登录失败 user=${username} ip=${ip} (${fails}/${MAX_FAILS})`);
      throw Object.assign(new Error('用户名或密码错误'), { statusCode: 401 });
    }

    this.failures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    const ttlMs = Math.max(1, Number(this.config.sessionTtlHours) || 12) * 3600 * 1000;
    const session = { username, createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
    this.sessions.set(token, session);
    this.log.info(`登录成功 user=${username} ip=${ip}`);
    return {
      token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      username,
      mustChangePassword: this.needsPasswordChange(username),
    };
  }

  logout(token) {
    return this.sessions.delete(token);
  }

  validate(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  pruneSessions() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

module.exports = { Auth, parseCookies, SESSION_COOKIE: 'fanproxy_session', DEFAULT_PASSWORD };
