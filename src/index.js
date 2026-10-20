#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const configModule = require('./config');
const { detect, installHint } = require('./core/platform');
const { createLogger } = require('./logger');
const { Store } = require('./store');
const { StreamStore } = require('./core/streamstore');
const { Nginx } = require('./core/nginx');
const { Certbot } = require('./core/certbot');
const { Manager } = require('./core/manager');
const { Scheduler } = require('./core/scheduler');
const { Backup } = require('./core/backup');
const { Logs } = require('./core/logs');
const { Auth } = require('./core/auth');
const { Settings } = require('./core/settings');
const healthcheck = require('./core/healthcheck');
const { HealthMonitor } = require('./core/healthmonitor');
const { createServer } = require('./http/server');

function main() {
  const config = configModule.load();
  const logger = createLogger(config.logLevel);
  const platform = config.platform || detect();
  logger.info(`运行环境: ${platform.label} · ${platform.name} · init=${platform.init} · pkg=${platform.packageManager}`);
  fs.mkdirSync(config.dataDir, { recursive: true });

  const backup = new Backup(config);
  const store = new Store(config, {
    beforeChange: (reason) => backup.snapshot(reason, [snapshotEntry(store.file)]),
  });
  const streamStore = new StreamStore(config, {
    beforeChange: (reason) => backup.snapshot(reason, [snapshotEntry(streamStore.file)]),
  });
  const nginx = new Nginx(config);
  // 提前探测 nginx 版本：渲染 gRPC 站点时要用它决定 http2 指令写法
  nginx.version().catch(() => null);
  const certbot = new Certbot(config, logger);
  const logs = new Logs(config);
  const auth = new Auth({ config, logger });
  const settings = new Settings(config, { logger });
  const manager = new Manager({ config, store, streamStore, nginx, certbot, backup, healthcheck, settings, logger });
  const scheduler = new Scheduler({ config, manager, logger });
  const healthMonitor = new HealthMonitor({ config, store, settings, logger, healthcheck });

  manager.ensureSitesDir();
  try {
    manager.syncStreamDir();
    const swept = manager.sweep();
    if (swept.removed.length) logger.info(`已清理 ${swept.removed.length} 个失效配置: ${swept.removed.join(', ')}`);
    const sweptStreams = manager.sweepStreams();
    if (sweptStreams.removed.length) logger.info(`已清理 ${sweptStreams.removed.length} 个失效转发配置: ${sweptStreams.removed.join(', ')}`);
  } catch (err) {
    logger.warn(`清理失效配置失败: ${err.message}`);
  }

  const server = createServer({ config, store, streamStore, manager, nginx, certbot, scheduler, backup, logs, auth, settings, healthMonitor, logger });
  server.on('error', (err) => {
    logger.error(`面板监听失败 ${config.panel.host}:${config.panel.port} - ${err.message}`);
    process.exit(1);
  });
  server.listen(config.panel.port, config.panel.host, () => {
    logger.info(`fanproxy 面板已启动 http://${config.panel.host}:${config.panel.port}`);
    logger.info(`配置文件: ${config.configPath}`);
    logger.info(`站点配置目录: ${config.nginx.sitesDir}（每个代理一个 ${config.nginx.filePrefix || ''}<域名>.conf）`);
    if (!nginx.installed) logger.warn('未检测到 nginx，仅能生成配置，无法校验与 reload');
    const streamCheck = nginx.checkStreamInclude();
    if (streamStore.list().length && !streamCheck.ok) {
      logger.warn(`nginx 主配置里还没有 stream {} 块 include ${config.nginx.streamDir}，TCP 转发不会生效`);
    }
    if (streamStore.list().length) {
      // 旧版本每条转发规则自带 stream {} 包装，第二条规则上线会撞 "stream directive is duplicate"，
      // 启动时顺手迁移成「一个 stream {} 块 + 裸 server 块」，失败会自动还原。
      manager.setupStreamInclude()
        .then((result) => {
          if (result.already) return;
          if (result.ok) logger.info(`stream include 已整理：${result.detail}`);
          else logger.warn(`stream include 自动修复失败：${result.detail}`);
        })
        .catch((err) => logger.warn(`stream include 自动修复失败：${err.message}`));
    }
    if (!certbot.installed) logger.warn('未检测到 certbot，证书申请与续期不可用');
    if (!nginx.installed || !certbot.installed) logger.info(`在当前系统安装依赖: ${installHint(platform)}`);
    if (!fs.existsSync(config.nginx.sitesDir)) {
      const suggested = (platform.defaults?.sitesDir || []).find((dir) => fs.existsSync(dir));
      if (suggested && suggested !== config.nginx.sitesDir) {
        logger.warn(`站点目录 ${config.nginx.sitesDir} 不存在；当前系统的默认目录是 ${suggested}（改 nginx.sitesDir 或设置 FAN_NGINX_SITES_DIR）`);
      }
    }
    if (!config.panel.authToken && !auth.hasUsers()) {
      logger.warn('面板未设置账号与 authToken，处于无鉴权模式，请勿监听公网地址');
    }
    logger.info(`配置备份目录: ${backup.dir}${backup.enabled ? '' : ' (已关闭)'}`);
    const include = nginx.checkInclude();
    if (nginx.installed && !include.ok) {
      logger.warn(`nginx 主配置 ${include.mainConf || ''} 未引入站点目录，需加入: ${include.snippet}`);
      logger.warn('也可以登录面板后在「设置 → nginx 接入」里一键写入（会自动备份并校验）');
    }
    scheduler.start();
    healthMonitor.start();
  });

  const shutdown = (signal) => {
    logger.info(`收到 ${signal}，正在关闭...`);
    scheduler.stop();
    healthMonitor.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** 带错误处理的入口：bin/fanproxy.js 与 `node src/index.js` 都走这里。 */
function run() {
  try {
    main();
  } catch (err) {
    console.error(`[fanproxy] 启动失败: ${err.message}`);
    if (process.env.FAN_DEBUG) console.error(err.stack);
    else console.error('（设置 FAN_DEBUG=1 可查看完整堆栈）');
    process.exit(1);
  }
}

if (require.main === module) run();

function snapshotEntry(file) {
  const fs = require('node:fs');
  return { path: file, content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
}

module.exports = { main, run };
