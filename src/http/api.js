'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { render, confPath } = require('../core/renderer');
const { normalizeSite } = require('../store');
const { SESSION_COOKIE } = require('../core/auth');

module.exports = function createApi({ config, store, streamStore, manager, scheduler, logger, auth, logs, backup, settings, healthMonitor }) {
  const requireStreams = () => {
    if (!streamStore) throw Object.assign(new Error('TCP 转发功能未启用'), { statusCode: 400 });
    return streamStore;
  };

  const findStream = (id) => {
    const rule = requireStreams().get(id);
    if (!rule) throw Object.assign(new Error(`转发规则不存在: ${id}`), { statusCode: 404 });
    return rule;
  };

  const findSite = (id) => {
    const site = store.get(id);
    if (!site) throw Object.assign(new Error(`站点不存在: ${id}`), { statusCode: 404 });
    return site;
  };

  /** 站点附带健康检查信息：最近一次结果 + 最近 10 次竖条数据。 */
  const withHealth = (site) => ({
    ...site,
    health: healthMonitor ? healthMonitor.result(site.id) : null,
    history: healthMonitor ? healthMonitor.historyOf(site.id) : [],
  });

  const requireBackup = () => {
    if (!backup) throw Object.assign(new Error('备份功能未启用'), { statusCode: 400 });
    return backup;
  };

  const sitesFromQuery = (query) => {
    if (query.siteId) return [findSite(query.siteId)];
    return store.list();
  };

  /**
   * 判断这次保存是否需要「自动申请证书」：勾了 HTTPS，但没有可用的证书路径。
   * 更新时以补丁 + 现有站点合并后的结果为准，避免误判。
   */
  const needsCertificate = (body, existing = null) => {
    const ssl = body.ssl || {};
    const inherited = existing?.ssl || {};
    const enabled = ssl.enabled === undefined ? Boolean(inherited.enabled) : Boolean(ssl.enabled);
    if (!enabled) return false;
    const certPath = ssl.certPath === undefined ? inherited.certPath : ssl.certPath;
    const keyPath = ssl.keyPath === undefined ? inherited.keyPath : ssl.keyPath;
    return !certPath || !keyPath;
  };

  /** 勾选/取消「测试证书」时也需要重签（staging 与生产证书互不通用）。 */
  const certTypeSwitched = (body, existing) => {
    if (!existing || body.ssl?.staging === undefined || body.ssl?.enabled === false) return false;
    return Boolean(body.ssl.staging) !== Boolean(existing.ssl?.staging);
  };

  /** 路径是否落在 certbot 的 live 目录里（= 由 fanproxy/certbot 管理的证书）。 */
  const inCertbotLive = (file) => {
    const liveDir = config.certbot.liveDir;
    if (!file || !liveDir) return false;
    const root = path.resolve(liveDir);
    const target = path.resolve(file);
    return target.startsWith(`${root}${path.sep}`);
  };

  /**
   * 取消勾选「启用 HTTPS」时释放 certbot 管理的证书路径。
   * 否则站点会一直“占着”这张证书：证书页始终显示关联、不能删除，得手动清空两个输入框。
   * 用户自己填的第三方证书路径（不在 certbot live 目录）保持不动。
   */
  const releaseCertificate = (body, existing) => {
    const enabled = body.ssl?.enabled === undefined ? Boolean(existing?.ssl?.enabled) : Boolean(body.ssl.enabled);
    if (enabled) return body;
    const certPath = body.ssl?.certPath === undefined ? existing?.ssl?.certPath : body.ssl.certPath;
    const keyPath = body.ssl?.keyPath === undefined ? existing?.ssl?.keyPath : body.ssl.keyPath;
    if (!inCertbotLive(certPath) && !inCertbotLive(keyPath)) return body;
    return { ...body, ssl: { ...(body.ssl || {}), certPath: '', keyPath: '' } };
  };

  /** 关闭 HTTP 时必须启用 HTTPS，否则站点没有可用的入口。 */
  const assertHttpUsable = (body, existing) => {
    const httpEnabled = body.httpEnabled === undefined ? existing?.httpEnabled !== false : body.httpEnabled !== false;
    const sslEnabled = body.ssl?.enabled === undefined ? Boolean(existing?.ssl?.enabled) : Boolean(body.ssl.enabled);
    if (!httpEnabled && !sslEnabled) {
      throw Object.assign(new Error('「关闭 HTTP（仅 HTTPS 访问）」需要同时勾选「启用 HTTPS」并完成证书签发'), { statusCode: 400 });
    }
  };

  /** 先把站点按 HTTP 落库（证书签发成功后再由 manager 写回 ssl 配置）。 */
  const pendingHttps = (body) => ({ ...body, ssl: { ...(body.ssl || {}), enabled: false } });

  const certOptions = (body) => ({ email: body.ssl?.email, staging: body.ssl?.staging });

  const reported = (result) => (result ? { ok: result.ok, reused: Boolean(result.reused), steps: result.steps } : null);

  /** 转发规则落库后写配置：失败不抛错，把原因放在 applied 里，规则本身保留便于修正。 */
  const tryApplyStream = async (rule) => {
    try {
      return await manager.applyStream(rule);
    } catch (err) {
      logger.warn(`应用 TCP 转发 ${rule.name || rule.listenPort} 失败: ${err.message}`);
      return { ok: false, steps: [{ step: '应用转发规则', ok: false, detail: err.message }] };
    }
  };

  /** 签发失败只作为结果返回：站点已经按 HTTP 存下来了，不该让整个保存请求报错。 */
  const tryEnsureHttps = async (site, options) => {
    try {
      return await manager.ensureHttps(site, options);
    } catch (err) {
      logger.warn(`站点 ${site.name} 自动申请证书失败: ${err.message}`);
      return {
        ok: false,
        reused: false,
        site: store.get(site.id) || site,
        steps: [{ step: '自动申请证书', ok: false, detail: err.message }],
      };
    }
  };

  return {
    async health() {
      return { ok: true, uptime: process.uptime(), pid: process.pid, version: require('../../package.json').version };
    },

    async platform() {
      const hint = require('../core/platform').installHint(config.platform || {});
      return {
        platform: config.platform
          ? {
              family: config.platform.family,
              label: config.platform.label,
              name: config.platform.name,
              version: config.platform.version,
              init: config.platform.init,
              packageManager: config.platform.packageManager,
              nginxUser: config.platform.nginxUser,
            }
          : null,
        paths: {
          mainConf: config.nginx.mainConf,
          sitesDir: config.nginx.sitesDir,
          logDir: config.nginx.logDir,
          webroot: config.certbot.webroot,
          liveDir: config.certbot.liveDir,
        },
        include: manager.nginx.checkInclude(),
        installHint: hint,
      };
    },

    async setupInclude({ deps }) {
      deps.logger.info('尝试把站点目录 include 写入 nginx 主配置');
      return manager.setupInclude();
    },

    // ---------- 认证 ----------

    async me({ authState }) {
      return {
        authenticated: Boolean(authState),
        mode: authState?.mode || null,
        username: authState?.username || null,
        hasUsers: auth.hasUsers(),
        mustChangePassword: authState?.mode === 'session' ? auth.needsPasswordChange(authState.username) : false,
        requiresAuth: auth.hasUsers() || Boolean(config.panel.authToken),
      };
    },

    async login({ body, req, res, deps }) {
      const ip = clientIp(req);
      const result = auth.login(String(body.username || ''), String(body.password || ''), ip);
      setSessionCookie(res, result.token, config, req);
      deps.logger.info(`面板登录：${result.username}`);
      return {
        ok: true,
        username: result.username,
        expiresAt: result.expiresAt,
        mustChangePassword: result.mustChangePassword,
      };
    },

    async logout({ req, res, deps }) {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) auth.logout(token);
      clearSessionCookie(res, config, req);
      deps.logger.info('面板登出');
      return { ok: true };
    },

    async changePassword({ authState, body }) {
      if (authState?.mode !== 'session') {
        throw Object.assign(new Error('只有登录会话可以修改密码'), { statusCode: 403 });
      }
      const target = body.username || authState.username;
      if (target !== authState.username && !body.force) {
        throw Object.assign(new Error('只能修改自己的密码'), { statusCode: 403 });
      }
      auth.upsert(target, String(body.password || ''));
      return { ok: true, username: target };
    },

    async listUsers() {
      return { users: auth.listUsers(), open: !auth.hasUsers() };
    },

    async upsertUser({ body }) {
      const username = auth.upsert(String(body.username || ''), String(body.password || ''));
      return { ok: true, username };
    },

    async deleteUser({ params }) {
      const removed = auth.remove(params.username);
      if (!removed) throw Object.assign(new Error(`用户不存在: ${params.username}`), { statusCode: 404 });
      return { ok: true };
    },

    // ---------- 状态与站点 ----------

    async status() {
      const base = await manager.status();
      return {
        ...base,
        sites: base.sites.map(withHealth),
        scheduler: { ...manager.config.scheduler, lastRun: scheduler?.lastRun || null, lastResult: scheduler?.lastResult || null },
        healthcheck: {
          ...(settings ? settings.healthcheck : config.healthcheck),
          lastRun: healthMonitor?.lastRun || null,
          lastResult: healthMonitor?.lastResult || null,
        },
        panel: {
          host: config.panel.host,
          port: config.panel.port,
          auth: Boolean(config.panel.authToken),
          users: auth.listUsers().map((user) => user.username),
        },
      };
    },

    async listSites() {
      return { sites: store.list().map(withHealth) };
    },

    async getSite({ params }) {
      return { site: findSite(params.id) };
    },

    async createSite({ body, deps }) {
      const payload = releaseCertificate(body, null);
      assertHttpUsable(payload, null);
      // 勾了 HTTPS 又没有证书时：先按 HTTP 存下来，签发成功再切换，避免保存直接报错
      const autoCert = payload.apply !== false && needsCertificate(payload);
      const site = store.create(autoCert ? pendingHttps(payload) : payload);
      deps.logger.info(`新增站点 ${site.name} (${site.id})`);
      let applied = null;
      let issued = null;
      if (autoCert) {
        deps.logger.info(`站点 ${site.name} 勾选 HTTPS，开始自动申请证书`);
        issued = await tryEnsureHttps(site, certOptions(payload));
      } else if (payload.apply !== false) {
        applied = await manager.applySite(site);
      }
      return { status: 201, body: { site: issued?.site || store.get(site.id) || site, applied, issued: reported(issued) } };
    },

    async updateSite({ params, body, deps }) {
      const current = store.get(params.id);
      if (!current) throw Object.assign(new Error(`站点不存在: ${params.id}`), { statusCode: 404 });
      const payload = releaseCertificate(body, current);
      assertHttpUsable(payload, current);
      const switched = certTypeSwitched(payload, current);
      const autoCert = needsCertificate(payload, current) || switched;
      const site = store.update(params.id, autoCert && !switched ? pendingHttps(payload) : payload);
      deps.logger.info(`更新站点 ${site.name} (${site.id})`);
      let applied = null;
      let issued = null;
      if (payload.apply === false) {
        // 只保存不生效：HTTPS 留到申请证书后再切换
        return { site, applied, issued, pending: autoCert };
      }
      if (autoCert) {
        deps.logger.info(switched
          ? `站点 ${site.name} 切换了证书类型（staging），开始强制重新签发`
          : `站点 ${site.name} 勾选 HTTPS，开始自动申请证书`);
        issued = await tryEnsureHttps(site, { ...certOptions(payload), force: switched });
      } else {
        applied = await manager.applySite(site);
      }
      return { site: issued?.site || store.get(site.id) || site, applied, issued: reported(issued) };
    },

    async deleteSite({ params, deps }) {
      const site = findSite(params.id);
      const removed = store.remove(site.id);
      const applied = await manager.applySite({ ...removed, enabled: false });
      deps.logger.info(`删除站点 ${removed.name} (${removed.id})`);
      return { removed, applied };
    },

    async pruneConfFiles({ deps }) {
      const result = manager.sweep();
      deps.logger.info(`清理孤儿配置 ${result.removed.length} 个`);
      return { ok: true, removed: result.removed };
    },

    async applyAllSites({ deps }) {
      const results = await manager.applyAll();
      deps.logger.info(`批量应用 ${results.length} 个站点，成功 ${results.filter((item) => item.ok).length} 个`);
      return { ok: results.every((item) => item.ok), results };
    },

    async previewSite({ params, body }) {
      const site = store.get(params.id) || normalizeSite({ id: params.id, ...body });
      return { config: render(site, config) };
    },

    async applySite({ params, body, deps }) {
      const site = findSite(params.id);
      const target = body.enabled === undefined ? site : store.update(site.id, { enabled: Boolean(body.enabled) });
      const result = await manager.applySite(target);
      deps.logger.info(`${target.enabled ? '应用' : '停用'}站点 ${target.name} -> ${result.ok ? '成功' : '失败'}`);
      return { ok: result.ok, site: target, snapshotId: result.snapshotId, steps: result.steps };
    },

    async healthCheckSite({ params, query }) {
      const site = findSite(params.id);
      const result = await manager.healthCheck(site, { timeoutMs: Number(query.timeoutMs) || undefined, path: query.path || undefined });
      if (healthMonitor && result && result.siteId) healthMonitor.record(result.siteId, result);
      return { ...result, history: healthMonitor ? healthMonitor.historyOf(site.id) : [] };
    },

    async siteLogs({ params, query }) {
      const site = findSite(params.id);
      const stats = await logs.stats([site], { hours: Number(query.hours) || undefined, top: Number(query.top) || undefined });
      return { siteId: site.id, ...stats };
    },

    async siteErrors({ params, query }) {
      const site = findSite(params.id);
      return logs.errors(site, Number(query.limit) || 100);
    },

    async globalLogs({ query }) {
      const sites = sitesFromQuery(query);
      const stats = await logs.stats(sites, { hours: Number(query.hours) || undefined, top: Number(query.top) || undefined });
      return { sites: sites.map((site) => ({ id: site.id, name: site.name })), ...stats };
    },

    // ---------- 证书 ----------

    async issueCertificate({ params, body, deps }) {
      const site = findSite(params.id);
      deps.logger.info(`开始为 ${site.name} 申请证书${body.force ? '（强制重签）' : ''}`);
      const result = await manager.issueCertificate(site, { email: body.email, staging: body.staging, force: body.force });
      return { ok: result.ok, site: result.site, steps: result.steps };
    },

    async listCertificates() {
      const certificates = (await manager.certbot.certificates()) || [];
      const now = Date.now();
      const sites = store.list();
      return {
        installed: manager.certbot.installed,
        certificates: certificates.map((cert) => {
          const linked = sites.filter((site) => site.ssl?.certPath && manager.certificateName(site) === cert.name);
          // staging 优先看证书文件本身的 issuer，其次看引用它的站点配置
          const fromFile = manager.certbot.isStaging(cert.name);
          return {
            ...cert,
            daysLeft: cert.expiresAt ? Math.floor((Date.parse(cert.expiresAt) - now) / 86400000) : null,
            staging: fromFile === null ? (linked.length ? linked.every((site) => site.ssl.staging) : null) : fromFile,
            sites: linked.map((site) => ({ id: site.id, name: site.name, enabled: site.enabled })),
          };
        }),
      };
    },

    async deleteCertificate({ params, deps }) {
      const name = params.name;
      deps.logger.info(`删除证书 ${name}`);
      return manager.deleteCertificate(name);
    },

    async renewCertificates({ deps }) {
      deps.logger.info('手动触发证书续期检查');
      const result = await manager.renewCertificates();
      return { ok: result.ok, skipped: Boolean(result.skipped), detail: result.detail, output: result.output };
    },

    // ---------- TCP/UDP 转发（stream 模块） ----------

    async listStreams() {
      const support = await manager.nginx.streamSupport();
      return {
        streams: requireStreams().list(),
        dir: config.nginx.streamDir,
        include: manager.nginx.checkStreamInclude(),
        module: support,
      };
    },

    async createStream({ body, deps }) {
      const rule = requireStreams().create(body);
      deps.logger.info(`新增 TCP 转发 ${rule.name || rule.listenPort}: ${rule.listenPort} -> ${rule.backend.host}:${rule.backend.port}`);
      const applied = await tryApplyStream(rule);
      return { status: 201, body: { stream: rule, applied } };
    },

    async getStream({ params }) {
      return { stream: findStream(params.id) };
    },

    async updateStream({ params, body, deps }) {
      findStream(params.id);
      const rule = requireStreams().update(params.id, body);
      deps.logger.info(`更新 TCP 转发 ${rule.name || rule.listenPort}`);
      const applied = await tryApplyStream(rule);
      return { stream: rule, applied };
    },

    async deleteStream({ params, deps }) {
      const rule = findStream(params.id);
      requireStreams().remove(rule.id);
      const applied = await manager.applyStream({ ...rule, enabled: false });
      deps.logger.info(`删除 TCP 转发 ${rule.name || rule.listenPort}`);
      return { removed: rule, applied };
    },

    async applyStream({ params, body, deps }) {
      const rule = findStream(params.id);
      const target = body.enabled === undefined ? rule : requireStreams().update(rule.id, { enabled: Boolean(body.enabled) });
      const result = await manager.applyStream(target);
      deps.logger.info(`${target.enabled ? '应用' : '停用'} TCP 转发 ${target.name || target.listenPort} -> ${result.ok ? '成功' : '失败'}`);
      return { ok: result.ok, stream: target, snapshotId: result.snapshotId, steps: result.steps };
    },

    async applyAllStreams({ deps }) {
      const results = await manager.applyAllStreams();
      deps.logger.info(`批量应用 ${results.length} 条转发规则，成功 ${results.filter((item) => item.ok).length} 条`);
      return { ok: results.every((item) => item.ok), results };
    },

    async setupStreamInclude({ deps }) {
      deps.logger.info('整理 nginx 主配置里的 stream include');
      return manager.setupStreamInclude();
    },

    // ---------- 健康检查设置 ----------

    async getHealthSettings() {
      return {
        healthcheck: {
          ...(settings ? settings.healthcheck : config.healthcheck),
          lastRun: healthMonitor?.lastRun || null,
          lastResult: healthMonitor?.lastResult || null,
        },
      };
    },

    async updateHealthSettings({ body, deps }) {
      if (!settings) throw Object.assign(new Error('设置模块未启用'), { statusCode: 400 });
      const healthcheck = settings.updateHealthcheck(body || {});
      healthMonitor?.restart();
      deps.logger.info(`更新健康检查设置: ${JSON.stringify(healthcheck)}`);
      return { ok: true, healthcheck };
    },

    // ---------- 备份 ----------

    async listBackups({ query }) {
      const backups = requireBackup();
      return {
        enabled: backups.enabled,
        dir: backups.dir,
        keep: backups.keep,
        counts: backups.counts(),
        backups: backups.list(Number(query.limit) || 50),
      };
    },

    async createBackup({ body, deps }) {
      const backups = requireBackup();
      const files = [snapshotEntry(store.file)];
      for (const site of store.list()) files.push(snapshotEntry(confPath(site, config)));
      // 手动快照带 manual 标记：永久保留，不参与 backup.keep 的自动裁剪
      const id = backups.snapshot(String(body.reason || '手动快照'), files, { manual: true });
      deps.logger.info(`已创建手动快照 ${id}（永久保留）`);
      return { ok: Boolean(id), id, files: files.length };
    },

    async restoreBackup({ params, deps }) {
      const backups = requireBackup();
      deps.logger.warn(`回滚快照 ${params.id}`);
      const result = await manager.restoreSnapshot(params.id);
      store.load();
      return result;
    },

    async deleteBackup({ params }) {
      const backups = requireBackup();
      return { ok: backups.remove(params.id) };
    },
  };
};

function snapshotEntry(file) {
  return { path: file, content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '-';
}

function setSessionCookie(res, token, config, req) {
  const ttlSeconds = Math.max(1, Number(config.panel.sessionTtlHours) || 12) * 3600;
  res.setHeader('Set-Cookie', cookieString(SESSION_COOKIE, token, ttlSeconds, config, req));
}

function clearSessionCookie(res, config, req) {
  res.setHeader('Set-Cookie', cookieString(SESSION_COOKIE, '', 0, config, req));
}

function cookieString(name, value, maxAge, config, req) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
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
