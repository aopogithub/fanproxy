'use strict';

const fs = require('node:fs');

const { logPaths } = require('./renderer');

const COMBINED_RE =
  /^(\S+) (\S+) (\S+) \[([^\]]+)\] "(\S+) (\S+) ([^"]*)" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?/;

/** nginx 访问日志解析与聚合统计（按站点读取独立 access_log）。 */
class Logs {
  constructor(config) {
    this.config = config;
    this.maxBytes = Number(config.logs.maxBytes) || 8 * 1024 * 1024;
    this.maxLines = Number(config.logs.maxLines) || 2000;
  }

  siteLogPath(site) {
    return logPaths(site, this.config).access;
  }

  errorLogPath(site) {
    return logPaths(site, this.config).error;
  }

  async stats(sites, options = {}) {
    const hours = Number(options.hours) || this.config.logs.defaultHours || 24;
    const since = Date.now() - hours * 3600 * 1000;

    const aggregate = emptyAggregate();
    const files = [];

    for (const site of sites) {
      const file = this.siteLogPath(site);
      const info = { siteId: site.id, siteName: site.name, path: file, exists: fs.existsSync(file), size: 0, lines: 0 };
      if (info.exists) {
        info.size = fs.statSync(file).size;
        const text = readTail(file, this.maxBytes);
        for (const line of text.split('\n')) {
          const entry = parseLine(line);
          if (!entry) continue;
          if (entry.timestamp && entry.timestamp < since) continue;
          info.lines += 1;
          accumulate(aggregate, entry);
        }
      }
      files.push(info);
    }

    finalize(aggregate, Number(options.top) || 10);
    return {
      hours,
      window: { from: new Date(since).toISOString(), to: new Date().toISOString() },
      files,
      ...aggregate,
    };
  }

  /** 读取站点错误日志尾部，便于面板直接排障。 */
  async errors(site, limit = 100) {
    const file = this.errorLogPath(site);
    if (!fs.existsSync(file)) return { path: file, exists: false, lines: [] };
    const text = readTail(file, Math.min(this.maxBytes, 512 * 1024));
    const lines = text.split('\n').filter(Boolean).slice(-limit);
    return { path: file, exists: true, lines };
  }
}

function readTail(file, maxBytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseLine(line) {
  const match = COMBINED_RE.exec(line);
  if (!match) return null;
  const [, ip, , , time, method, target, , status, bytes, referer = '', userAgent = ''] = match;
  return {
    ip,
    timestamp: parseTime(time),
    method,
    target,
    status: Number(status),
    bytes: bytes === '-' ? 0 : Number(bytes),
    referer,
    userAgent,
  };
}

function parseTime(value) {
  // 形如 11/Sep/2026:15:10:59 +0800
  const match = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(value);
  if (!match) return null;
  const [, day, monthName, year, hh, mm, ss, zone] = match;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months.indexOf(monthName);
  if (month === -1) return null;
  const iso = `${year}-${String(month + 1).padStart(2, '0')}-${day}T${hh}:${mm}:${ss}${zone.slice(0, 3)}:${zone.slice(3)}`;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : ts;
}

function emptyAggregate() {
  return {
    total: 0,
    bytes: 0,
    statusClasses: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 },
    statusCodes: new Map(),
    methods: new Map(),
    paths: new Map(),
    ips: new Map(),
    agents: new Map(),
    perHour: new Map(),
    firstAt: null,
    lastAt: null,
    recent: [],
  };
}

function accumulate(agg, entry) {
  agg.total += 1;
  agg.bytes += entry.bytes;

  const cls = `${Math.floor(entry.status / 100)}xx`;
  if (cls in agg.statusClasses) agg.statusClasses[cls] += 1;
  else agg.statusClasses.other += 1;

  bump(agg.statusCodes, String(entry.status));
  bump(agg.methods, entry.method);
  bump(agg.paths, normalizePath(entry.target));
  bump(agg.ips, entry.ip);
  if (entry.userAgent) bump(agg.agents, entry.userAgent);

  if (entry.timestamp) {
    const hour = new Date(Math.floor(entry.timestamp / 3600000) * 3600000).toISOString();
    bump(agg.perHour, hour);
    if (agg.firstAt === null || entry.timestamp < agg.firstAt) agg.firstAt = entry.timestamp;
    if (agg.lastAt === null || entry.timestamp > agg.lastAt) agg.lastAt = entry.timestamp;
  }

  agg.recent.push({ at: entry.timestamp, ip: entry.ip, method: entry.method, path: entry.target, status: entry.status, bytes: entry.bytes });
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function normalizePath(target) {
  if (typeof target !== 'string' || !target) return '-';
  const trimmed = target.split('?')[0];
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}

function finalize(agg, top) {
  const toTop = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, count]) => ({ key, count }));
  const hours = [...agg.perHour.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([hour, count]) => ({ hour, count }));

  agg.topPaths = toTop(agg.paths);
  agg.topIPs = toTop(agg.ips);
  agg.topAgents = toTop(agg.agents);
  agg.statusCodes = Object.fromEntries([...agg.statusCodes.entries()].sort((a, b) => Number(a[0]) - Number(b[0])));
  agg.methods = Object.fromEntries([...agg.methods.entries()].sort((a, b) => b[1] - a[1]));
  agg.timeline = hours;
  agg.errorRate = agg.total ? Number(((agg.statusClasses['4xx'] + agg.statusClasses['5xx']) / agg.total).toFixed(4)) : 0;
  agg.recent = agg.recent.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 50);

  for (const key of ['paths', 'ips', 'agents', 'perHour']) delete agg[key];
  if (agg.firstAt !== null) agg.firstAt = new Date(agg.firstAt).toISOString();
  if (agg.lastAt !== null) agg.lastAt = new Date(agg.lastAt).toISOString();
  return agg;
}

module.exports = { Logs, parseLine, parseTime, readTail };
