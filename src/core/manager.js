'use strict';

const fs = require('node:fs');
const path = require('node:path');

const renderer = require('./renderer');
const { lookupUser } = require('./platform');

/**
 * 站点编排层：把「期望状态」落到 nginx 配置与证书上。
 * 所有改动都遵循 渲染 -> nginx -t -> reload 的顺序，校验失败自动回滚。
 */
class Manager {
  constructor({ config, store, streamStore, nginx, certbot, backup, healthcheck, settings, logger }) {
    this.config = config;
    this.store = store;
    this.streamStore = streamStore || null;
    this.nginx = nginx;
    this.certbot = certbot;
    this.backup = backup;
    this.healthcheck = healthcheck;
    this.settings = settings || null;
    this.log = logger;
  }

  ensureSitesDir() {
    const logDir = path.join(this.config.nginx.logDir, 'fanproxy');
    for (const dir of [this.config.nginx.sitesDir, this.config.nginx.streamDir, this.config.certbot.webroot, logDir]) {
      this.mkdirOrExplain(dir);
    }
    // 日志目录尽量交给 nginx 运行用户（Debian 是 www-data，RHEL/Alpine 是 nginx）
    this.chownForNginx(logDir);
  }

  /** 建目录；失败时给出「需要什么权限 / 改哪个配置项」的可读提示。 */
  mkdirOrExplain(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      const permission = ['EACCES', 'EPERM', 'EROFS'].includes(err.code);
      const missing = err.code === 'ENOENT' || err.code === 'ENOTDIR';
      const hint = permission || missing
        ? `${err.code}；面板需要 root（或对相关目录有写权限），也可以改 config.json 里的 nginx.sitesDir / nginx.logDir / certbot.webroot`
        : err.message;
      throw Object.assign(new Error(`无法创建目录 ${dir}: ${hint}`), { statusCode: 500 });
    }
  }

  /** 以 root 运行时把目录属主改成 nginx 用户，失败不影响启动。 */
  chownForNginx(dir) {
    const user = this.config.nginx.user;
    if (!user || typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
    const info = lookupUser(user);
    if (!info) return false;
    try {
      fs.chownSync(dir, info.uid, info.gid);
      return true;
    } catch (err) {
      this.log?.debug?.(`chown ${dir} -> ${user} 失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 把站点目录的 include 写进 nginx 主配置（写前快照、写后校验，失败自动还原）。
   * 不同发行版的主配置位置与 include 目录都不同，这里全部走检测结果。
   */
  async setupInclude() {
    const mainConf = this.config.nginx.mainConf;
    if (!mainConf || !fs.existsSync(mainConf)) {
      throw Object.assign(new Error(`nginx 主配置不存在: ${mainConf || '(未配置)'}`), { statusCode: 400 });
    }
    if (this.nginx.checkInclude().ok) {
      return { ok: true, already: true, file: mainConf, snippet: this.nginx.checkInclude().snippet };
    }

    const previous = fs.readFileSync(mainConf, 'utf8');
    const snapshotId = this.backup?.snapshot('写入 nginx include', [{ path: mainConf, content: previous }]) || null;

    const added = this.nginx.addInclude();
    if (!added.ok) return { ok: false, snapshotId, detail: added.detail };

    const test = await this.nginx.test();
    if (!test.ok) {
      this.nginx.restoreMainConf(previous);
      return { ok: false, snapshotId, restored: true, detail: (test.stderr || test.stdout).trim() };
    }

    const reload = await this.reload();
    return {
      ok: reload.ok,
      file: mainConf,
      snippet: added.snippet,
      snapshotId,
      reload: reload.attempts || [],
      detail: reload.ok ? 'include 已写入并 reload' : (reload.stderr || reload.stdout || '').trim(),
    };
  }

  /**
   * 清理 nginx 配置目录里由 fanproxy 生成、但已不对应任何启用站点的 .conf。
   * 只删除带托管标记的文件，不会动用户自己写的配置。
   */
  sweep() {
    const dir = this.config.nginx.sitesDir;
    if (!fs.existsSync(dir)) return { removed: [] };
    const used = new Set(
      this.store.list().filter((site) => site.enabled).map((site) => renderer.confPath(site, this.config)),
    );
    const removed = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.conf')) continue;
      const full = path.join(dir, name);
      if (used.has(full)) continue;
      const head = fs.readFileSync(full, 'utf8').slice(0, 300);
      if (!renderer.isManaged(head)) continue;
      fs.rmSync(full, { force: true });
      removed.push(name);
    }
    return { removed };
  }

  /** 记录站点配置文件快照，便于回滚。 */
  snapshotConf(site, file, previous) {
    if (!this.backup) return null;
    return this.backup.snapshot(`${site.enabled === false ? '停用' : '应用'}站点 ${site.name}`, [
      { path: file, content: previous },
    ]);
  }

  /**
   * 目标文件名可能被用户手写的同名 conf 占用。这种情况下改名为 fanproxy-<域名>-2.conf，
   * 绝不覆盖非 fanproxy 生成的文件。
   */
  resolveConfFile(site) {
    const file = renderer.confPath(site, this.config);
    if (!fs.existsSync(file)) return site;
    const head = fs.readFileSync(file, 'utf8').slice(0, 300);
    // 只有本站点自己的托管文件才直接覆盖；被别人占用（用户手写或其他站点）时改名，避免覆盖别人的配置
    if (renderer.managedBy(head, site)) return site;

    const confFile = this.store.allocateConfFile({ ...site, confFile: '' });
    this.log.warn(`${file} 不是本站点的配置（用户手写或已被其他站点占用），改名为 ${confFile}`);
    return this.store.update(site.id, { confFile });
  }

  /**
   * 写入一份托管 conf 并生效（先快照，再 nginx -t，失败回滚）。
   * 站点（http）与 TCP 转发（stream）共用同一套流程。
   */
  async applyConf({ file, content, enabled, snapshotReason }) {
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const snapshotId = this.backup ? this.backup.snapshot(snapshotReason, [{ path: file, content: previous }]) : null;

    if (!enabled) {
      fs.rmSync(file, { force: true });
      const reloaded = await this.reload();
      return { ok: reloaded.ok, snapshotId, steps: [{ step: 'disable', ok: true }], reload: reloaded };
    }

    fs.writeFileSync(file, content, 'utf8');

    const test = await this.nginx.test();
    if (!test.ok) {
      if (previous === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, previous, 'utf8');
      return {
        ok: false,
        snapshotId,
        steps: [{ step: 'render', ok: true, file }, { step: 'nginx -t', ok: false, detail: test.stderr || test.stdout }],
      };
    }

    const reload = await this.reload();
    return {
      ok: reload.ok,
      snapshotId,
      steps: [
        { step: 'render', ok: true, file },
        { step: 'nginx -t', ok: true, detail: (test.stderr + test.stdout).trim() },
        { step: 'nginx -s reload', ok: reload.ok, detail: (reload.stderr || reload.stdout).trim() },
      ],
    };
  }

  /** 将一个站点写入磁盘并生效；失败时回滚到上一个版本。 */
  async applySite(site) {
    const resolved = this.resolveConfFile(site);
    if (resolved !== site) return this.applySite(resolved);

    this.ensureSitesDir();
    const file = renderer.confPath(site, this.config);

    // 站点改过配置文件名时，先移除旧的托管文件
    this.removeStaleConfFiles(site, file);
    return this.applyConf({
      file,
      content: renderer.render(site, this.config),
      enabled: site.enabled,
      snapshotReason: `${site.enabled === false ? '停用' : '应用'}站点 ${site.name}`,
    });
  }

  /** 站点重命名/改域名后，删掉不再使用的旧配置文件（仅限 fanproxy 托管的）。 */
  removeStaleConfFiles(site, keepFile) {
    const dir = this.config.nginx.sitesDir;
    if (!fs.existsSync(dir)) return [];
    const removed = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.conf')) continue;
      const full = path.join(dir, name);
      if (full === keepFile) continue;
      const head = fs.readFileSync(full, 'utf8').slice(0, 300);
      if (!renderer.isManaged(head)) continue;
      if (!head.includes(`# site: ${site.name} (${site.id})`)) continue;
      fs.rmSync(full, { force: true });
      removed.push(name);
    }
    return removed;
  }

  async applyAll() {
    const results = [];
    for (const site of this.store.list()) {
      results.push({ id: site.id, name: site.name, ...(await this.applySite(site)) });
    }
    return results;
  }

  /* ---------- TCP/UDP 转发（stream 模块） ---------- */

  /** 转发目录里必须有 .conf，否则 include 通配符会让 nginx -t 报错。 */
  syncStreamDir() {
    this.ensureSitesDir();
    const dir = this.config.nginx.streamDir;
    if (!dir || !fs.existsSync(dir)) return;
    const placeholder = renderer.streamPlaceholderName(this.config);
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.conf'));
    const real = files.filter((name) => name !== placeholder);
    if (!real.length && !files.includes(placeholder)) {
      fs.writeFileSync(path.join(dir, placeholder), renderer.streamPlaceholderContent(), 'utf8');
    } else if (real.length && files.includes(placeholder)) {
      fs.rmSync(path.join(dir, placeholder), { force: true });
    }
  }

  /** 目标文件被非本规则的配置占用时改名，避免覆盖别人的配置。 */
  resolveStreamConfFile(rule) {
    const file = renderer.streamConfPath(rule, this.config);
    if (!fs.existsSync(file)) return rule;
    const head = fs.readFileSync(file, 'utf8').slice(0, 300);
    if (renderer.managedBy(head, rule)) return rule;

    const confFile = this.streamStore.allocateConfFile({ ...rule, confFile: '' });
    this.log.warn(`${file} 不是本规则的配置，改名为 ${confFile}`);
    return this.streamStore.update(rule.id, { confFile });
  }

  async applyStream(rule) {
    const resolved = this.resolveStreamConfFile(rule);
    if (resolved !== rule) return this.applyStream(resolved);

    this.ensureSitesDir();
    if (rule.enabled !== false) {
      // 先把 include 落进 stream {} 块、把旧格式（自带 stream {} 包装）的转发 conf 刷成裸 server 块，
      // 否则新写的规则不会被加载，或者第二个 stream 块直接让 nginx -t 报 "stream directive is duplicate"
      const prep = await this.prepareStreamConfs({ excludeId: rule.id });
      if (!prep.ok) {
        return { ok: false, snapshotId: prep.snapshotId, steps: [{ step: 'stream include', ok: false, detail: prep.detail }] };
      }
    }
    if (!rule.enabled) this.syncStreamDir(); // 停用会删文件，先补占位文件免得 include 变空
    const file = renderer.streamConfPath(rule, this.config);
    this.removeStaleStreamConfFiles(rule, file);
    const result = await this.applyConf({
      file,
      content: renderer.renderStream(rule, this.config),
      enabled: rule.enabled,
      snapshotReason: `${rule.enabled === false ? '停用' : '应用'}TCP 转发 ${rule.name || rule.listenPort}`,
    });
    this.syncStreamDir();
    return result;
  }

  /** 规则改名/改端口后，删掉不再使用的旧配置文件（仅限 fanproxy 托管的）。 */
  removeStaleStreamConfFiles(rule, keepFile) {
    const dir = this.config.nginx.streamDir;
    if (!dir || !fs.existsSync(dir)) return [];
    const removed = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.conf')) continue;
      const full = path.join(dir, name);
      if (full === keepFile) continue;
      const head = fs.readFileSync(full, 'utf8').slice(0, 300);
      if (!renderer.isManaged(head)) continue;
      const tag = /^# stream: .*\(([0-9a-fA-F-]{8,})\)$/m.exec(head);
      if (!tag || tag[1] !== rule.id) continue;
      fs.rmSync(full, { force: true });
      removed.push(name);
    }
    return removed;
  }

  async applyAllStreams() {
    if (!this.streamStore) return [];
    const results = [];
    for (const rule of this.streamStore.list()) {
      results.push({ id: rule.id, name: rule.name || rule.listenPort, ...(await this.applyStream(rule)) });
    }
    return results;
  }

  /** 清理不再对应任何启用规则的托管 stream 配置。 */
  sweepStreams() {
    const dir = this.config.nginx.streamDir;
    if (!this.streamStore || !dir || !fs.existsSync(dir)) return { removed: [] };
    const used = new Set(
      this.streamStore.list().filter((rule) => rule.enabled).map((rule) => renderer.streamConfPath(rule, this.config)),
    );
    const removed = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.conf')) continue;
      const full = path.join(dir, name);
      if (used.has(full) || name === renderer.streamPlaceholderName(this.config)) continue;
      const head = fs.readFileSync(full, 'utf8').slice(0, 300);
      if (!renderer.isManaged(head)) continue;
      fs.rmSync(full, { force: true });
      removed.push(name);
    }
    this.syncStreamDir();
    return { removed };
  }

  /** applyStream 前的一次幂等整理，主配置不可写时不阻塞后续写入（交给 nginx -t 报错）。 */
  async prepareStreamConfs(options = {}) {
    try {
      return await this.setupStreamInclude(options);
    } catch (err) {
      this.log.warn(`整理 stream include 失败: ${err.message}`);
      return { ok: true, skipped: true, detail: err.message };
    }
  }

  /**
   * 整理转发相关配置（幂等）：
   * 1. 把 include 放进顶层 stream {} 块（主配置里已有 stream 块就复用，不新建第二个，顶层残留的那份会被删掉）；
   * 2. 把启用中的规则对应的 conf 刷成裸 server 块，缺文件的补上。
   * 写前快照，nginx -t 失败整体还原；没有可做的事时直接返回。
   */
  async setupStreamInclude({ excludeId = null } = {}) {
    const mainConf = this.config.nginx.mainConf;
    if (!mainConf || !fs.existsSync(mainConf)) {
      throw Object.assign(new Error(`nginx 主配置不存在: ${mainConf || '(未配置)'}`), { statusCode: 400 });
    }
    this.ensureSitesDir();
    this.syncStreamDir();

    const fix = this.nginx.streamIncludeEdit();
    if (!fix.ok) throw Object.assign(new Error(fix.detail || '无法修改 nginx 主配置'), { statusCode: 400 });
    // excludeId：正在被 applyStream 写入的那条规则交给它自己处理，避免同一个文件写两次、reload 两次
    const rewrites = this.streamConfSync({ excludeId });
    if (!fix.changed && !rewrites.length) {
      return { ok: true, already: true, file: mainConf, snippet: fix.snippet, mode: fix.mode };
    }

    const previous = fs.readFileSync(mainConf, 'utf8');
    const snapshotId = this.backup?.snapshot('整理 nginx stream 配置', [
      { path: mainConf, content: previous },
      ...rewrites.map((item) => ({ path: item.path, content: item.previous })),
    ]) || null;

    if (fix.changed) fs.writeFileSync(mainConf, fix.content, 'utf8');
    for (const item of rewrites) fs.writeFileSync(item.path, item.content, 'utf8');
    const restore = () => {
      fs.writeFileSync(mainConf, previous, 'utf8');
      for (const item of rewrites) {
        if (item.previous === null) fs.rmSync(item.path, { force: true });
        else fs.writeFileSync(item.path, item.previous, 'utf8');
      }
    };

    const test = await this.nginx.test();
    if (!test.ok) {
      restore();
      return { ok: false, snapshotId, restored: true, detail: (test.stderr || test.stdout).trim() };
    }

    const reload = await this.reload();
    const added = rewrites.filter((item) => item.previous === null).length;
    const done = [
      fix.changed ? `include 已写进 stream {} 块（${fix.mode}）` : 'include 无需改动',
      added ? `补了 ${added} 个缺失的转发配置` : null,
      rewrites.length - added ? `刷新了 ${rewrites.length - added} 个转发配置文件` : null,
    ].filter(Boolean).join('，');
    return {
      ok: reload.ok,
      file: mainConf,
      snippet: fix.snippet,
      mode: fix.mode,
      snapshotId,
      rewritten: rewrites.map((item) => path.basename(item.path)),
      reload: reload.attempts || [],
      detail: reload.ok ? `${done}，nginx 已 reload` : (reload.stderr || reload.stdout || '').trim(),
    };
  }

  /**
   * 磁盘上和「启用中的规则」不一致、需要重写的托管转发 conf：
   * - 文件不见了（例如上一次 apply 被 nginx -t 回滚掉）
   * - 格式过期（旧版本每条规则自带 stream {} 包装）
   * 非 fanproxy 托管的同名文件不会被碰。
   */
  streamConfSync({ excludeId = null } = {}) {
    if (!this.streamStore) return [];
    const out = [];
    for (const rule of this.streamStore.list()) {
      if (rule.enabled === false || rule.id === excludeId) continue;
      const file = renderer.streamConfPath(rule, this.config);
      const content = renderer.renderStream(rule, this.config);
      if (!fs.existsSync(file)) {
        out.push({ path: file, content, previous: null });
        continue;
      }
      const previous = fs.readFileSync(file, 'utf8');
      const head = previous.slice(0, 300);
      if (!renderer.isManaged(head) || !renderer.managedBy(head, rule)) continue;
      if (content !== previous) out.push({ path: file, content, previous });
    }
    return out;
  }

  async reload() {
    if (!this.nginx.installed) {
      return { ok: false, stderr: 'nginx 未安装，跳过 reload' };
    }
    return this.nginx.reload();
  }

  /**
   * 申请证书：先确保 HTTP 站点已生效（webroot 校验需要），
   * 再 certbot certonly，最后开启 ssl 并重新 apply。
   */
  async issueCertificate(site, options = {}) {
    if (!site.serverNames.length) {
      throw Object.assign(new Error('站点没有可用域名'), { statusCode: 400 });
    }

    // 校验阶段必须监听 80：即使站点设了「关闭 HTTP」，也要临时放通来做 ACME 校验
    const httpOnly = { ...site, httpEnabled: true, ssl: { ...site.ssl, enabled: false } };
    const applied = await this.applySite(httpOnly);
    if (!applied.ok) {
      const failed = applied.steps.find((step) => !step.ok);
      throw Object.assign(new Error(`站点未生效，无法完成域名校验: ${failed?.detail || '未知错误'}`), {
        statusCode: 400,
        steps: applied.steps,
      });
    }

    const primary = site.serverNames.find((name) => !name.startsWith('*'));
    // staging 优先级：本次请求 > 站点当前值 > 全局配置
    const requestedStaging = options.staging === undefined ? Boolean(site.ssl.staging) : Boolean(options.staging);
    const staging = requestedStaging || Boolean(this.config.certbot.staging);
    // 测试证书 <-> 生产证书互切时必须重签，否则 certbot 会因为「现有证书还没到期」直接跳过
    const switched = Boolean(site.ssl.staging) !== staging;
    const force = Boolean(options.force) || switched;
    if (force && switched) this.log?.info?.(`站点 ${site.name} 的证书类型变化，使用 --force-renewal 重新签发`);
    if (!requestedStaging && this.config.certbot.staging) {
      this.log?.warn?.('certbot.staging=true（config.json 或 FAN_CERTBOT_STAGING），即使没勾选「测试证书」也会签发测试证书');
    }

    const result = await this.certbot.obtain({
      serverNames: site.serverNames,
      email: options.email || site.ssl.email || this.config.certbot.email,
      staging,
      force,
    });

    if (!result.ok) {
      return { ok: false, steps: [...applied.steps, { step: 'certbot certonly', ok: false, detail: tail(result) }] };
    }

    const paths = this.certbot.certPaths(primary);
    const updated = this.store.update(site.id, {
      ssl: { enabled: true, certPath: paths.certPath, keyPath: paths.keyPath, staging },
    });

    const reapplied = await this.applySite(updated);
    return {
      ok: reapplied.ok,
      site: updated,
      steps: [
        ...applied.steps,
        { step: 'certbot certonly', ok: true, detail: tail(result) },
        ...reapplied.steps,
      ],
    };
  }

  /**
   * 找站点可用的证书：优先用站点里填的路径，其次看 certbot live 目录里
   * 是否已有同域名证书（手工签发过或上次签发残留），都没有则返回 null。
   */
  findCertificate(site) {
    const { certPath, keyPath } = site.ssl || {};
    if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) return { certPath, keyPath };
    const primary = site.serverNames.find((name) => !name.startsWith('*'));
    if (!primary) return null;
    const paths = this.certbot.certPaths(primary);
    if (fs.existsSync(paths.certPath) && fs.existsSync(paths.keyPath)) return paths;
    return null;
  }

  /**
   * 勾选 HTTPS 保存站点时的入口：已有证书直接启用，
   * 没有则自动走「HTTP 站点生效 -> certbot 签发 -> 切到 HTTPS」。
   */
  async ensureHttps(site, options = {}) {
    // force：测试证书换生产证书这类场景必须重签，不能复用现有证书文件
    const found = options.force ? null : this.findCertificate(site);
    if (found) {
      const updated = this.store.update(site.id, {
        ssl: { ...site.ssl, enabled: true, certPath: found.certPath, keyPath: found.keyPath },
      }) || site;
      const applied = await this.applySite(updated);
      return { ok: applied.ok, reused: true, site: updated, steps: applied.steps };
    }
    const result = await this.issueCertificate(site, options);
    return { ...result, reused: false };
  }

  /** 站点当前引用的证书名（certbot 的 --cert-name，即 live 目录下的一级目录名）。 */
  certificateName(site) {
    const file = site.ssl?.certPath;
    if (file) {
      const dir = path.basename(path.dirname(file));
      if (dir) return dir;
    }
    const primary = (site.serverNames || []).find((name) => !name.startsWith('*'));
    return primary || '';
  }

  /**
   * 删除证书。被站点引用的证书不能删：删掉之后站点的 ssl_certificate 会指向不存在的文件，
   * nginx 直接无法 reload。没关联站点的证书（比如测试证书、改域名后的残留）可以放心删。
   */
  async deleteCertificate(name) {
    const used = this.store.list().filter((site) => site.ssl?.certPath && this.certificateName(site) === name);
    if (used.length) {
      throw Object.assign(
        new Error(`证书 ${name} 仍被站点引用: ${used.map((site) => site.name).join('、')}；请先在站点里取消启用 HTTPS 或换成其它证书`),
        { statusCode: 400, sites: used.map((site) => ({ id: site.id, name: site.name })) },
      );
    }
    const result = await this.certbot.deleteCert(name);
    return { ok: result.ok, detail: result.ok ? `已删除 ${name}` : tail(result) };
  }

  /** 回滚某一份快照，并让 nginx 重新加载。 */
  async restoreSnapshot(id) {
    if (!this.backup) throw Object.assign(new Error('备份功能未启用'), { statusCode: 400 });
    const result = this.backup.restore(id);
    const test = await this.nginx.test();
    if (!test.ok) {
      return { ok: false, restored: false, ...result, detail: (test.stderr || test.stdout).trim() };
    }
    const reload = await this.reload();
    return { ok: reload.ok, restored: true, ...result, detail: (reload.stderr || reload.stdout).trim() };
  }

  /** 检查上游连通性（TCP，可选 HTTP 探测）。站点级路径优先，其次面板设置。 */
  async healthCheck(site, options = {}) {
    if (!this.healthcheck) return { ok: false, error: '健康检查模块未启用' };
    const cfg = this.settings?.healthcheck || this.config.healthcheck || {};
    return this.healthcheck.checkSite(site, {
      timeoutMs: options.timeoutMs || cfg.timeoutMs,
      path: options.path || (site.advanced?.healthCheckPath || cfg.path || '').trim() || undefined,
    });
  }

  /** 续期：certbot 只在临近到期时真正续，reload 交给 deploy-hook。 */
  async renewCertificates() {
    if (!this.certbot.installed) {
      return { ok: false, skipped: true, detail: 'certbot 未安装' };
    }
    fs.mkdirSync(this.config.certbot.webroot, { recursive: true });
    // 续期走的是 webroot（HTTP-01）校验，「仅 HTTPS」的站点要先临时放通 80 端口
    const restore = await this.openHttpForRenewal();
    try {
      const result = await this.certbot.renew({ deployHook: `${this.nginx.bin} -s reload` });
      return { ok: result.ok, detail: tail(result), output: result.stdout || result.stderr || '' };
    } finally {
      await restore();
    }
  }

  /**
   * 续期前把「关闭 HTTP」的站点临时按双栈渲染（80 端口只做 ACME 校验 + 跳转），
   * 返回恢复函数；没有这类站点时是空操作。
   */
  async openHttpForRenewal() {
    const affected = this.store.list().filter((site) => site.enabled && site.ssl.enabled && site.httpEnabled === false);
    if (!affected.length) return async () => {};
    this.log?.info?.(`续期前临时放通 80 端口（${affected.length} 个仅 HTTPS 站点）用于 ACME 校验`);
    for (const site of affected) {
      const applied = await this.applySite({ ...site, httpEnabled: true });
      if (!applied.ok) this.log?.warn?.(`临时放通 80 端口失败：${site.name}`);
    }
    return async () => {
      for (const site of affected) {
        const applied = await this.applySite(site);
        if (!applied.ok) this.log?.warn?.(`恢复「仅 HTTPS」配置失败：${site.name}，站点可能仍在监听 80 端口`);
      }
    };
  }

  async status() {
    const include = this.nginx.checkInclude();
    return {
      nginx: {
        installed: this.nginx.installed,
        bin: this.nginx.bin,
        version: await this.nginx.version(),
        sitesDir: this.config.nginx.sitesDir,
        include,
      },
      certbot: {
        installed: this.certbot.installed,
        bin: this.certbot.bin,
        version: await this.certbot.version(),
        webroot: this.config.certbot.webroot,
        staging: Boolean(this.config.certbot.staging),
      },
      scheduler: this.config.scheduler,
      platform: this.config.platform
        ? {
            family: this.config.platform.family,
            label: this.config.platform.label,
            name: this.config.platform.name,
            version: this.config.platform.version,
            init: this.config.platform.init,
            packageManager: this.config.platform.packageManager,
            nginxUser: this.config.platform.nginxUser,
          }
        : null,
      paths: {
        sitesDir: this.config.nginx.sitesDir,
        logDir: path.join(this.config.nginx.logDir, 'fanproxy'),
        webroot: this.config.certbot.webroot,
        backups: this.backup ? this.backup.dir : null,
      },
      backup: this.backup ? { enabled: this.backup.enabled, dir: this.backup.dir, keep: this.backup.keep } : null,
      streams: this.streamStore
        ? {
            dir: this.config.nginx.streamDir,
            include: this.nginx.streamDir ? this.nginx.checkStreamInclude() : null,
            module: await this.nginx.streamSupport(),
          }
        : null,
      sites: this.store.list().map((site) => ({
        id: site.id,
        name: site.name,
        enabled: site.enabled,
        serverNames: site.serverNames,
        confFile: renderer.confFileName(site, this.config),
        confPath: renderer.confPath(site, this.config),
        upstream: site.upstream,
        ssl: { enabled: site.ssl.enabled, autoRenew: site.ssl.autoRenew },
      })),
      nginxConfFiles: listConfFiles(this.config.nginx.sitesDir),
    };
  }
}

function listConfFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.conf')).sort();
}

function tail(result, max = 2000) {
  const text = `${result.stderr || ''}${result.stdout || ''}`.trim() || result.error || '';
  return text.length > max ? `${text.slice(-max)}` : text;
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

module.exports = { Manager, ensureParent };
