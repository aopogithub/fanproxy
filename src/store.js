'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { confFileName, managedBy } = require('./core/renderer');
const { normalizeScheme } = require('./core/protocol');

const SITE_DEFAULTS = {
  enabled: true,
  confFile: '',
  serverNames: [],
  listenHttp: 80,
  listenHttps: 443,
  // false = 不监听 HTTP 端口（仅 HTTPS 访问）；只在 ssl.enabled 为真时生效
  httpEnabled: true,
  upstream: {
    scheme: 'http',
    host: '127.0.0.1',
    port: 8080,
    websocket: false,
  },
  ssl: {
    enabled: false,
    provider: 'certbot',
    email: '',
    staging: false,
    autoRenew: true,
    certPath: '',
    keyPath: '',
  },
  advanced: {
    clientMaxBodySize: '64m',
    extraHeaders: [],
    extraLocations: '',
    accessLog: '',
    errorLog: '',
    healthCheckPath: '',
  },
};

const DOMAIN_RE = /^(?:\*\.)?(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

function normalizeSite(input = {}, existing = null) {
  const base = existing ? mergeSite(existing, input) : mergeSite(SITE_DEFAULTS, input);
  const now = new Date().toISOString();

  return {
    id: base.id || crypto.randomUUID(),
    confFile: String(base.confFile || ''),
    name: String(base.name || '').trim(),
    enabled: base.enabled !== false,
    serverNames: normalizeDomainList(base.serverNames),
    listenHttp: Number(base.listenHttp) || 80,
    listenHttps: Number(base.listenHttps) || 443,
    httpEnabled: base.httpEnabled !== false,
    upstream: {
      scheme: normalizeScheme(base.upstream?.scheme),
      host: String(base.upstream?.host || '127.0.0.1'),
      port: Number(base.upstream?.port) || 80,
      websocket: Boolean(base.upstream?.websocket),
    },
    ssl: {
      enabled: Boolean(base.ssl?.enabled),
      provider: base.ssl?.provider || 'certbot',
      email: String(base.ssl?.email || ''),
      staging: Boolean(base.ssl?.staging),
      autoRenew: base.ssl?.autoRenew !== false,
      certPath: String(base.ssl?.certPath || ''),
      keyPath: String(base.ssl?.keyPath || ''),
    },
    advanced: {
      clientMaxBodySize: String(base.advanced?.clientMaxBodySize || '64m'),
      extraHeaders: Array.isArray(base.advanced?.extraHeaders) ? base.advanced.extraHeaders.map(String) : [],
      extraLocations: String(base.advanced?.extraLocations || ''),
      accessLog: String(base.advanced?.accessLog || ''),
      errorLog: String(base.advanced?.errorLog || ''),
      healthCheckPath: String(base.advanced?.healthCheckPath || ''),
    },
    createdAt: base.createdAt || now,
    updatedAt: now,
  };
}

function validateSite(site) {
  const errors = [];
  if (!site.name) errors.push('name 不能为空');
  if (!site.serverNames.length) errors.push('serverNames 至少需要一个域名');
  for (const domain of site.serverNames) {
    if (!DOMAIN_RE.test(domain)) errors.push(`域名格式不正确: ${domain}`);
  }
  if (!site.upstream.host) errors.push('upstream.host 不能为空');
  if (!Number.isInteger(site.upstream.port) || site.upstream.port < 1 || site.upstream.port > 65535) {
    errors.push('upstream.port 必须是 1-65535 的整数');
  }
  if (site.ssl.enabled && (!site.ssl.certPath || !site.ssl.keyPath)) {
    errors.push('启用 HTTPS 需要 certPath 与 keyPath（可先通过面板申请证书）');
  }
  return errors;
}

function normalizeDomainList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return [...new Set(list.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

function mergeSite(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object'
      ? { ...base[key], ...value }
      : value;
  }
  return out;
}

class Store {
  constructor(config, options = {}) {
    this.config = config;
    this.file = path.join(config.dataDir, 'sites.json');
    this.sites = [];
    this.beforeChange = options.beforeChange || null;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) {
      this.sites = [];
      return this.sites;
    }
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.sites = (raw.sites || []).map((site) => normalizeSite(site, site));

    // 老数据没有 confFile：按域名补一个，并把旧的 <uuid>.conf 交给 sweep 清理
    let migrated = false;
    for (const site of this.sites) {
      if (site.confFile) continue;
      site.confFile = this.allocateConfFile(site);
      migrated = true;
    }
    if (migrated) this.save();
    return this.sites;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, sites: this.sites }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.sites.slice();
  }

  get(id) {
    return this.sites.find((site) => site.id === id) || null;
  }

  create(input) {
    const site = normalizeSite(input);
    if (!site.confFile) site.confFile = this.allocateConfFile(site);
    const errors = validateSite(site);
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { statusCode: 400, errors });
    this.beforeChange?.(`新增站点 ${site.name}`);
    this.sites.push(site);
    this.save();
    return site;
  }

  /** 为站点分配唯一的配置文件名，避免覆盖 conf.d 中已存在的文件。 */
  allocateConfFile(site) {
    const taken = new Set(this.sites.map((item) => item.confFile).filter(Boolean));
    const base = confFileName({ ...site, confFile: '' }, this.config);
    const candidates = [base];
    for (let i = 2; i <= 50; i += 1) candidates.push(base.replace(/\.conf$/, `-${i}.conf`));

    for (const name of candidates) {
      if (taken.has(name)) continue;
      const full = path.join(this.config.nginx.sitesDir, name);
      if (!fs.existsSync(full)) return name;
      // 已存在的文件：只有「本站点自己生成的」才复用，别人的（用户手写或其他站点）一律让开
      const head = fs.readFileSync(full, 'utf8').slice(0, 300);
      if (managedBy(head, site)) return name;
    }
    return base.replace(/\.conf$/, `-${site.id.slice(0, 8)}.conf`);
  }

  update(id, patch) {
    const index = this.sites.findIndex((site) => site.id === id);
    if (index === -1) return null;
    const site = normalizeSite(patch, this.sites[index]);
    const errors = validateSite(site);
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { statusCode: 400, errors });
    this.beforeChange?.(`更新站点 ${site.name}`);
    this.sites[index] = site;
    this.save();
    return site;
  }

  remove(id) {
    const index = this.sites.findIndex((site) => site.id === id);
    if (index === -1) return null;
    this.beforeChange?.(`删除站点 ${this.sites[index].name}`);
    const [site] = this.sites.splice(index, 1);
    this.save();
    return site;
  }
}

module.exports = { Store, normalizeSite, validateSite, normalizeDomainList, SITE_DEFAULTS };
