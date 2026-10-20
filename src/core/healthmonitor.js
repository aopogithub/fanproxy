'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 站点列表里展示的竖条数量：保留最近 20 次探测结果。 */
const HISTORY_LIMIT = 20;

/**
 * 主动健康检查：按固定间隔并发探测所有已启用站点的上游（TCP + 可选 HTTP），
 * 每个站点保留最近 HISTORY_LIMIT 条结果并持久化到 dataDir/health.json，重启不丢。
 */
class HealthMonitor {
  constructor({ config, store, settings, logger, healthcheck }) {
    this.config = config;
    this.store = store;
    this.settings = settings;
    this.log = logger;
    this.healthcheck = healthcheck;
    this.file = path.join(config.dataDir, 'health.json');
    this.timer = null;
    this.running = false;
    this.lastRun = null;
    this.lastResult = null;
    this.history = this.load();
  }

  /** 探测参数：面板设置优先，其次 config.json / 环境变量。 */
  get options() {
    return this.settings?.healthcheck || this.config.healthcheck || {};
  }

  load() {
    if (!fs.existsSync(this.file)) return {};
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const out = {};
      for (const [siteId, list] of Object.entries(saved || {})) {
        if (Array.isArray(list)) out[siteId] = list.filter((item) => item && typeof item === 'object').slice(-HISTORY_LIMIT);
      }
      return out;
    } catch (err) {
      this.log?.warn?.(`健康检查历史解析失败，已忽略 ${this.file}: ${err.message}`);
      return {};
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.history, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log?.warn?.(`写入健康检查历史失败: ${err.message}`);
    }
  }

  start() {
    this.stop();
    const cfg = this.options;
    if (cfg.enabled === false) {
      this.log?.info?.('主动健康检查未启用 (healthcheck.enabled=false)');
      return;
    }
    const intervalMs = Math.max(10, Number(cfg.intervalSeconds) || 60) * 1000;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.log?.warn?.(`主动健康检查异常: ${err.message}`));
    }, intervalMs);
    this.timer.unref?.();
    this.log?.info?.(`主动健康检查已启动，每 ${intervalMs / 1000} 秒探测 ${this.store.list().filter((s) => s.enabled).length} 个站点`);
    // 启动后先跑一轮，避免站点列表一开始全是灰条
    setTimeout(() => {
      this.runOnce().catch((err) => this.log?.warn?.(`主动健康检查异常: ${err.message}`));
    }, 2000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 设置变更后重建定时器（间隔可能变了，也可能被关掉）。 */
  restart() {
    this.start();
    return this.options;
  }

  async runOnce() {
    if (this.running) return { skipped: true, reason: '上一轮探测尚未结束' };
    this.running = true;
    const at = new Date().toISOString();
    try {
      const sites = this.store.list().filter((site) => site.enabled);
      const results = await Promise.all(sites.map(async (site) => {
        const result = await this.probe(site);
        this.record(site.id, result, { persist: false });
        return { siteId: site.id, name: site.name, ok: Boolean(result.ok) };
      }));
      this.prune();
      this.lastRun = at;
      this.lastResult = { at, total: results.length, ok: results.filter((item) => item.ok).length };
      this.save();
      return this.lastResult;
    } finally {
      this.running = false;
    }
  }

  /** 探测单个站点：站点级路径优先于全局默认路径。 */
  async probe(site) {
    const cfg = this.options;
    return this.healthcheck.checkSite(site, {
      timeoutMs: cfg.timeoutMs,
      path: (site.advanced?.healthCheckPath || cfg.path || '').trim() || undefined,
    });
  }

  record(siteId, result, { persist = true } = {}) {
    const list = this.history[siteId] || [];
    list.push(compact(result));
    this.history[siteId] = list.slice(-HISTORY_LIMIT);
    if (persist) this.save();
    return this.history[siteId][this.history[siteId].length - 1];
  }

  /** 清理已删除站点的历史。 */
  prune() {
    const ids = new Set(this.store.list().map((site) => site.id));
    for (const key of Object.keys(this.history)) {
      if (!ids.has(key)) delete this.history[key];
    }
  }

  historyOf(siteId) {
    return [...(this.history[siteId] || [])];
  }

  /** 最近一次探测结果（没有则为 null）。 */
  result(siteId) {
    const list = this.history[siteId] || [];
    return list.length ? { ...list[list.length - 1] } : null;
  }

  snapshot() {
    const out = {};
    for (const [siteId, list] of Object.entries(this.history)) out[siteId] = [...list];
    return out;
  }
}

function compact(result) {
  const error = result.tcp?.ok === false
    ? result.tcp.error
    : (result.http && result.http.ok === false ? result.http.error : null);
  return {
    at: result.checkedAt || new Date().toISOString(),
    ok: Boolean(result.ok),
    latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
    status: result.status !== undefined ? result.status : null,
    error: error || null,
  };
}

module.exports = { HealthMonitor, HISTORY_LIMIT };
