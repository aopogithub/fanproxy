'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 面板可写的设置，存在 dataDir/settings.json。
 * 优先级：内置默认 < config.json / 环境变量 < settings.json（面板里改的）。
 * 只暴露白名单字段，避免把配置文件写坏。
 */
const DEFAULTS = {
  healthcheck: {
    enabled: true,
    intervalSeconds: 60,
    timeoutMs: 3000,
    path: '',
  },
};

const LIMITS = {
  intervalSeconds: [10, 86400],
  timeoutMs: [200, 60000],
};

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

class Settings {
  constructor(config, options = {}) {
    this.config = config;
    this.log = options.logger || null;
    this.file = path.join(config.dataDir, 'settings.json');
    this.values = this.load();
  }

  load() {
    let saved = {};
    if (fs.existsSync(this.file)) {
      try {
        saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
      } catch (err) {
        this.log?.warn?.(`设置文件解析失败，已忽略 ${this.file}: ${err.message}`);
        saved = {};
      }
    }
    const fromConfig = this.config.healthcheck || {};
    return {
      healthcheck: { ...DEFAULTS.healthcheck, ...fromConfig, ...(saved.healthcheck || {}) },
    };
  }

  get healthcheck() {
    return { ...this.values.healthcheck };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.values, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  updateHealthcheck(patch = {}) {
    const next = { ...this.values.healthcheck };
    if (patch.enabled !== undefined) next.enabled = bool(patch.enabled, next.enabled);

    for (const key of Object.keys(LIMITS)) {
      if (patch[key] === undefined || patch[key] === '') continue;
      const value = Number(patch[key]);
      const [min, max] = LIMITS[key];
      if (!Number.isFinite(value) || value < min || value > max) {
        throw Object.assign(new Error(`${key} 需要在 ${min} ~ ${max} 之间`), { statusCode: 400 });
      }
      next[key] = Math.round(value);
    }

    if (patch.path !== undefined) {
      const value = String(patch.path || '').trim();
      if (value && !value.startsWith('/')) {
        throw Object.assign(new Error('健康检查路径需要以 / 开头（留空表示只做 TCP 探测）'), { statusCode: 400 });
      }
      next.path = value;
    }

    this.values.healthcheck = next;
    this.save();
    return this.healthcheck;
  }
}

module.exports = { Settings, DEFAULTS, LIMITS };
