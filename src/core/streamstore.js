'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { streamConfFileName, managedBy } = require('./renderer');

/**
 * TCP/UDP 转发规则（nginx stream 模块，4 层）。
 * 与站点分开存 data/streams.json，每个规则一个独立 conf（默认 fanproxy-stream-<名称>-<端口>.conf）。
 */
const STREAM_DEFAULTS = {
  enabled: true,
  confFile: '',
  name: '',
  protocol: 'tcp',
  listenAddress: '',
  listenPort: 8443,
  backend: { host: '127.0.0.1', port: 443 },
  connectTimeoutSeconds: 5,
  proxyTimeoutSeconds: 600,
};

const PROTOCOLS = ['tcp', 'udp'];

function normalizeStream(input = {}, existing = null) {
  const base = existing ? mergeStream(existing, input) : mergeStream(STREAM_DEFAULTS, input);
  const now = new Date().toISOString();
  const protocol = String(base.protocol || 'tcp').toLowerCase();
  return {
    id: base.id || crypto.randomUUID(),
    confFile: String(base.confFile || ''),
    name: String(base.name || '').trim(),
    enabled: base.enabled !== false,
    protocol: PROTOCOLS.includes(protocol) ? protocol : 'tcp',
    listenAddress: String(base.listenAddress || '').trim(),
    listenPort: Number(base.listenPort) || 8443,
    backend: {
      host: String(base.backend?.host || '127.0.0.1').trim(),
      port: Number(base.backend?.port) || 443,
    },
    connectTimeoutSeconds: Number(base.connectTimeoutSeconds) || 5,
    proxyTimeoutSeconds: Number(base.proxyTimeoutSeconds) || 600,
    createdAt: base.createdAt || now,
    updatedAt: now,
  };
}

/** 单条规则自身的校验；端口冲突需要结合其它规则，见 StreamStore#conflict。 */
function validateStream(rule) {
  const errors = [];
  if (!Number.isInteger(rule.listenPort) || rule.listenPort < 1 || rule.listenPort > 65535) {
    errors.push('listenPort 必须是 1-65535 的整数');
  }
  if (rule.listenAddress && !/^[0-9a-fA-F:.]+$/.test(rule.listenAddress)) {
    errors.push(`监听地址格式不正确: ${rule.listenAddress}`);
  }
  if (!rule.backend.host) errors.push('backend.host 不能为空');
  if (!Number.isInteger(rule.backend.port) || rule.backend.port < 1 || rule.backend.port > 65535) {
    errors.push('backend.port 必须是 1-65535 的整数');
  }
  if (!Number.isFinite(rule.connectTimeoutSeconds) || rule.connectTimeoutSeconds < 1) errors.push('connectTimeoutSeconds 至少为 1');
  if (!Number.isFinite(rule.proxyTimeoutSeconds) || rule.proxyTimeoutSeconds < 1) errors.push('proxyTimeoutSeconds 至少为 1');
  return errors;
}

/** 监听端口冲突检测：同协议 + 同地址 + 同端口（启用中的规则之间）。 */
function findConflict(rule, rules) {
  return rules.find((item) => item.id !== rule.id
    && item.enabled !== false
    && rule.enabled !== false
    && item.protocol === rule.protocol
    && item.listenPort === rule.listenPort
    && (item.listenAddress || '') === (rule.listenAddress || '')) || null;
}

class StreamStore {
  constructor(config, options = {}) {
    this.config = config;
    this.file = path.join(config.dataDir, 'streams.json');
    this.streams = [];
    this.beforeChange = options.beforeChange || null;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) {
      this.streams = [];
      return this.streams;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.streams = (raw.streams || []).map((rule) => normalizeStream(rule, rule));
    } catch (err) {
      this.streams = [];
      this.loadError = err.message;
    }
    return this.streams;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, streams: this.streams }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.streams.slice();
  }

  get(id) {
    return this.streams.find((rule) => rule.id === id) || null;
  }

  create(input) {
    const rule = normalizeStream(input);
    if (!rule.confFile) rule.confFile = this.allocateConfFile(rule);
    const errors = validateStream(rule);
    const conflict = findConflict(rule, this.streams);
    if (conflict) errors.push(`监听端口与其它规则冲突: ${conflict.name || conflict.id} 已占用 ${conflict.protocol} ${conflict.listenAddress || '*'}:${conflict.listenPort}`);
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { statusCode: 400, errors });
    this.beforeChange?.(`新增 TCP 转发 ${rule.name || rule.listenPort}`);
    this.streams.push(rule);
    this.save();
    return rule;
  }

  update(id, patch) {
    const index = this.streams.findIndex((rule) => rule.id === id);
    if (index === -1) return null;
    const rule = normalizeStream(patch, this.streams[index]);
    const errors = validateStream(rule);
    const conflict = findConflict(rule, this.streams);
    if (conflict) errors.push(`监听端口与其它规则冲突: ${conflict.name || conflict.id} 已占用 ${conflict.protocol} ${conflict.listenAddress || '*'}:${conflict.listenPort}`);
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { statusCode: 400, errors });
    this.beforeChange?.(`更新 TCP 转发 ${rule.name || rule.listenPort}`);
    this.streams[index] = rule;
    this.save();
    return rule;
  }

  remove(id) {
    const index = this.streams.findIndex((rule) => rule.id === id);
    if (index === -1) return null;
    this.beforeChange?.(`删除 TCP 转发 ${this.streams[index].name || this.streams[index].listenPort}`);
    const [rule] = this.streams.splice(index, 1);
    this.save();
    return rule;
  }

  /** 为规则分配唯一的配置文件名，避免覆盖 stream 目录里已存在的文件。 */
  allocateConfFile(rule) {
    const taken = new Set(this.streams.map((item) => item.confFile).filter(Boolean));
    const base = streamConfFileName({ ...rule, confFile: '' }, this.config);
    const candidates = [base];
    for (let i = 2; i <= 50; i += 1) candidates.push(base.replace(/\.conf$/, `-${i}.conf`));

    for (const name of candidates) {
      if (taken.has(name)) continue;
      const full = path.join(this.config.nginx.streamDir, name);
      if (!fs.existsSync(full)) return name;
      const head = fs.readFileSync(full, 'utf8').slice(0, 300);
      if (managedBy(head, rule)) return name;
    }
    return base.replace(/\.conf$/, `-${rule.id.slice(0, 8)}.conf`);
  }
}

function mergeStream(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object'
      ? { ...base[key], ...value }
      : value;
  }
  return out;
}

module.exports = { StreamStore, normalizeStream, validateStream, STREAM_DEFAULTS };
