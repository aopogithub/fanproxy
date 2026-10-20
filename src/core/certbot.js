'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { run, resolveBinary } = require('./exec');

class Certbot {
  constructor(config, logger) {
    this.config = config.certbot;
    this.bin = resolveBinary(this.config.bin);
    this.log = logger || null;
  }

  /** 执行前把完整命令行写进面板日志，便于排查「卡住/没反应」。 */
  exec(args) {
    this.log?.info?.(`执行 certbot: ${this.bin || this.config.bin} ${args.join(' ')}`);
    const timeout = Number(this.config.timeoutMs);
    return run(this.bin, args, Number.isFinite(timeout) && timeout > 0 ? { timeout } : {});
  }

  get installed() {
    return Boolean(this.bin);
  }

  liveDir(domain) {
    return path.join(this.config.liveDir || '/etc/letsencrypt/live', domain);
  }

  certPaths(domain) {
    const dir = this.liveDir(domain);
    return {
      certPath: path.join(dir, 'fullchain.pem'),
      keyPath: path.join(dir, 'privkey.pem'),
    };
  }

  async version() {
    if (!this.installed) return null;
    const result = await run(this.bin, ['--version']);
    return `${result.stdout}${result.stderr}`.trim() || null;
  }

  /**
   * 通过 webroot 方式签发证书。要求站点已用 HTTP 监听 80 并放通
   * /.well-known/acme-challenge/，因此调用方应先 apply 站点。
   */
  async obtain({ serverNames, email, staging = false, force = false }) {
    if (!this.installed) {
      return { ok: false, code: 127, stdout: '', stderr: 'certbot 未安装或不在 PATH 中' };
    }
    const domains = serverNames.filter((name) => !name.startsWith('*.'));
    if (!domains.length) {
      return { ok: false, code: 1, stdout: '', stderr: 'webroot 方式不支持泛域名，请至少提供一个普通域名' };
    }
    const args = [
      'certonly',
      '--webroot',
      '-w', this.config.webroot,
      '--agree-tos',
      '--non-interactive',
      // force：用于「测试证书换生产证书」这类必须重签的场景，否则 certbot 会认为现有证书还能用而跳过
      force ? '--force-renewal' : '--keep-until-expiring',
    ];
    for (const domain of domains) args.push('-d', domain);
    if (email || this.config.email) args.push('--email', email || this.config.email);
    else args.push('--register-unsafely-without-email');
    if (staging || this.config.staging) args.push('--staging');
    args.push(...(this.config.extraArgs || []));
    fs.mkdirSync(this.config.webroot, { recursive: true });
    return this.exec(args);
  }

  /** 续期全部证书；--deploy-hook 可在续期后 reload nginx。 */
  async renew({ deployHook } = {}) {
    if (!this.installed) {
      return { ok: false, code: 127, stdout: '', stderr: 'certbot 未安装或不在 PATH 中' };
    }
    const args = ['renew', '--non-interactive'];
    if (deployHook) args.push('--deploy-hook', deployHook);
    args.push(...(this.config.extraArgs || []));
    return this.exec(args);
  }

  /**
   * 判断某条证书是不是 Let's Encrypt 测试（staging）签发：
   * staging 中间证书的 issuer 里带 (STAGING) / Fake LE 字样，直接在 DER 里找这个字符串。
   * 返回 true / false / null（读不到文件时未知）。
   */
  isStaging(name) {
    try {
      const pem = fs.readFileSync(path.join(this.liveDir(name), 'cert.pem'), 'utf8');
      const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
      return der.includes('(STAGING)') || der.includes('Fake LE');
    } catch {
      return null;
    }
  }

  /** 删除一条证书 lineage（certbot delete --cert-name）。 */
  async deleteCert(name) {
    if (!this.installed) {
      return { ok: false, code: 127, stdout: '', stderr: 'certbot 未安装或不在 PATH 中' };
    }
    if (!name) return { ok: false, code: 1, stdout: '', stderr: '证书名不能为空' };
    return this.exec(['delete', '--cert-name', String(name), '--non-interactive', ...(this.config.extraArgs || [])]);
  }

  /** 解析证书到期时间，用于面板展示与到期提醒。 */
  async certificates() {
    if (!this.installed) return null;
    const result = await run(this.bin, ['certificates']);
    if (!result.ok) return null;
    return parseCertificates(result.stdout);
  }
}

/**
 * 解析 `certbot certificates` 的输出。
 * 每条证书以 `Certificate Name:` 开头，中间的分隔线在真实输出里是 `- - - - -`（带空格），
 * 所以按 `Certificate Name:` 切块，不能用 /-{5,}/ 切，否则多条证书只会解析出第一条。
 */
function parseCertificates(stdout) {
  const certs = [];
  const chunks = String(stdout).split(/Certificate Name:/).slice(1);
  for (const chunk of chunks) {
    const name = chunk.match(/^\s*(\S+)/);
    if (!name) continue;
    const expiry = chunk.match(/Expiry Date:\s*(.+?)\s*\(/);
    const domains = chunk.match(/Domains:\s*(.+)/);
    certs.push({
      name: name[1],
      domains: domains ? domains[1].trim().split(/\s+/) : [],
      expiresAt: expiry ? new Date(expiry[1]).toISOString() : null,
    });
  }
  return certs;
}

module.exports = { Certbot, parseCertificates };
