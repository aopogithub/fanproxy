'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * 配置快照与回滚。
 * 每次 apply/删除站点前把受影响文件的内容存成一份快照，出现问题时可以一键还原。
 * 手动创建的快照带 manual 标记，永久保留，不参与 backup.keep 的自动裁剪。
 */
class Backup {
  constructor(config) {
    this.enabled = config.backup.enabled !== false;
    this.dir = config.backup.dir
      ? path.resolve(config.backup.dir)
      : path.join(config.dataDir, 'backups');
    this.keep = Math.max(1, Number(config.backup.keep) || 50);
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 记录快照。files: [{ path, content }]，content 为 null 表示该文件当时不存在。
   * options.manual = true 表示面板里手动创建的快照，不参与自动裁剪。
   */
  snapshot(reason, files = [], options = {}) {
    if (!this.enabled || !files.length) return null;
    this.ensureDir();

    const at = new Date();
    const id = `${at.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const payload = {
      id,
      at: at.toISOString(),
      reason,
      manual: Boolean(options.manual),
      files: files.map((file) => ({
        path: file.path,
        existed: file.content !== null && file.content !== undefined,
        content: file.content ?? null,
      })),
    };

    fs.writeFileSync(path.join(this.dir, `${id}.json`), `${JSON.stringify(payload, null, 2)}\n`);
    this.prune();
    return id;
  }

  list(limit = 50) {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((name) => {
        const meta = this.read(name);
        if (!meta) return null;
        return {
          id: meta.id,
          at: meta.at,
          reason: meta.reason,
          manual: Boolean(meta.manual),
          files: meta.files.map((file) => ({ path: file.path, existed: file.existed })),
        };
      })
      .filter(Boolean);
  }

  get(id) {
    return this.read(`${id}.json`);
  }

  read(filename) {
    const file = path.join(this.dir, path.basename(filename));
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** 回滚快照；返回每个文件的处理结果。 */
  restore(id) {
    const snapshot = this.get(id);
    if (!snapshot) throw Object.assign(new Error(`快照不存在: ${id}`), { statusCode: 404 });

    const results = snapshot.files.map((file) => {
      if (!file.existed) {
        fs.rmSync(file.path, { force: true });
        return { path: file.path, action: 'removed' };
      }
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content, 'utf8');
      return { path: file.path, action: 'restored' };
    });

    return { id, reason: snapshot.reason, at: snapshot.at, files: results };
  }

  remove(id) {
    const file = path.join(this.dir, `${path.basename(id)}.json`);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }

  /** 只裁剪自动快照：手动快照永久保留，不计入 keep。 */
  prune() {
    const files = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json')).sort();
    const auto = files.filter((name) => !this.read(name)?.manual);
    for (const name of auto.slice(0, Math.max(0, auto.length - this.keep))) {
      fs.rmSync(path.join(this.dir, name), { force: true });
    }
  }

  /** 快照计数：auto 参与 keep 裁剪，manual 永久保留。 */
  counts() {
    const backups = this.list(Number.MAX_SAFE_INTEGER);
    const manual = backups.filter((item) => item.manual).length;
    return { auto: backups.length - manual, manual, total: backups.length };
  }
}

module.exports = { Backup };
