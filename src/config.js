'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { detect, firstExisting } = require('./core/platform');

const ROOT = path.resolve(__dirname, '..');

/**
 * 依据检测到的操作系统生成默认路径，用户配置与环境变量仍然优先。
 */
function buildDefaults(platform) {
  const nginxDefault = platform?.defaults || {};
  const sitesDir = firstExisting(nginxDefault.sitesDir || ['/etc/nginx/conf.d']);
  // TCP 转发（stream）配置目录：默认与站点目录同级，例如 /etc/nginx/conf.d -> /etc/nginx/stream.d
  const streamDir = nginxDefault.streamDir || path.join(path.dirname(sitesDir), 'stream.d');
  return {
  panel: {
    host: '127.0.0.1',
    port: 8787,
    authToken: '',
    sessionTtlHours: 12,
    adminUser: 'admin',
    // 默认账号 admin/admin；设为 "" 表示不建账号（面板无鉴权）。首次登录后建议立即改密。
    adminPassword: 'admin',
  },
  nginx: {
    bin: 'nginx',
    mainConf: firstExisting(nginxDefault.mainConf || ['/etc/nginx/nginx.conf']),
    sitesDir,
    streamDir,
    filePrefix: 'fanproxy-',
    logDir: nginxDefault.logDir || '/var/log/nginx',
    logFormat: 'combined',
    user: platform?.nginxUser || '',
  },
  certbot: {
    bin: 'certbot',
    email: '',
    webroot: nginxDefault.webroot || '/var/www/certbot',
    liveDir: nginxDefault.certbotLiveDir || '/etc/letsencrypt/live',
    staging: false,
    renewBeforeDays: 30,
    timeoutMs: 5 * 60 * 1000,
    extraArgs: [],
  },
  scheduler: {
    enabled: true,
    intervalMinutes: 720,
  },
  backup: {
    enabled: true,
    dir: '',
    keep: 50,
  },
  logs: {
    maxBytes: 8 * 1024 * 1024,
    maxLines: 2000,
    defaultHours: 24,
  },
  healthcheck: {
    enabled: true,
    intervalSeconds: 60,
    timeoutMs: 3000,
    path: '',
  },
  dataDir: path.join(ROOT, 'data'),
  logLevel: 'info',
  };
}

const DEFAULTS = buildDefaults(null);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function merge(base, override) {
  const out = clone(base);
  for (const [key, value] of Object.entries(override || {})) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

function envOverrides(env = process.env) {
  const overrides = { panel: {}, nginx: {}, certbot: {}, scheduler: {}, backup: {}, logs: {}, healthcheck: {} };
  const set = (group, key, value, cast = String) => {
    if (value === undefined || value === '') return;
    overrides[group][key] = cast(value);
  };

  set('panel', 'host', env.FAN_HOST);
  set('panel', 'port', env.FAN_PORT, Number);
  set('panel', 'authToken', env.FAN_TOKEN);
  set('panel', 'adminUser', env.FAN_ADMIN_USER);
  set('panel', 'adminPassword', env.FAN_ADMIN_PASSWORD);
  set('panel', 'sessionTtlHours', env.FAN_SESSION_TTL_HOURS, Number);
  set('nginx', 'bin', env.FAN_NGINX_BIN);
  set('nginx', 'mainConf', env.FAN_NGINX_MAIN_CONF);
  set('nginx', 'sitesDir', env.FAN_NGINX_SITES_DIR);
  set('nginx', 'streamDir', env.FAN_NGINX_STREAM_DIR);
  set('nginx', 'filePrefix', env.FAN_NGINX_FILE_PREFIX);
  set('nginx', 'logDir', env.FAN_NGINX_LOG_DIR);
  set('nginx', 'user', env.FAN_NGINX_USER);
  set('certbot', 'bin', env.FAN_CERTBOT_BIN);
  set('certbot', 'email', env.FAN_CERTBOT_EMAIL);
  set('certbot', 'webroot', env.FAN_CERTBOT_WEBROOT);
  set('certbot', 'liveDir', env.FAN_CERTBOT_LIVE_DIR);
  set('certbot', 'staging', env.FAN_CERTBOT_STAGING, (v) => v === '1' || v === 'true');
  set('certbot', 'renewBeforeDays', env.FAN_CERTBOT_RENEW_DAYS, Number);
  set('certbot', 'timeoutMs', env.FAN_CERTBOT_TIMEOUT_MS, Number);
  set('scheduler', 'enabled', env.FAN_SCHEDULER_ENABLED, (v) => v !== '0' && v !== 'false');
  set('backup', 'enabled', env.FAN_BACKUP_ENABLED, (v) => v !== '0' && v !== 'false');
  set('backup', 'dir', env.FAN_BACKUP_DIR);
  set('backup', 'keep', env.FAN_BACKUP_KEEP, Number);
  set('logs', 'maxBytes', env.FAN_LOGS_MAX_BYTES, Number);
  set('healthcheck', 'enabled', env.FAN_HEALTHCHECK_ENABLED, (v) => v !== '0' && v !== 'false');
  set('healthcheck', 'intervalSeconds', env.FAN_HEALTHCHECK_INTERVAL, Number);
  set('healthcheck', 'timeoutMs', env.FAN_HEALTHCHECK_TIMEOUT, Number);
  set('healthcheck', 'path', env.FAN_HEALTHCHECK_PATH);

  return overrides;
}

function load(options = {}) {
  const platform = options.platform || detect(options.env || process.env);
  const defaults = buildDefaults(platform);
  const configPath = options.configPath || process.env.FAN_CONFIG || path.join(ROOT, 'config.json');
  let fileConfig = {};

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件解析失败 ${configPath}: ${err.message}`);
    }
  }

  const env = envOverrides();
  const config = merge(merge(defaults, fileConfig), env);
  // 只改了站点目录、没单独指定 streamDir 时，让转发目录跟着站点目录走，避免两个目录分家
  const sitesDirSet = Boolean(fileConfig.nginx?.sitesDir || env.nginx.streamDir === undefined && env.nginx.sitesDir);
  const streamDirSet = Boolean(fileConfig.nginx?.streamDir || env.nginx.streamDir);
  if (sitesDirSet && !streamDirSet) {
    config.nginx.streamDir = path.join(path.dirname(config.nginx.sitesDir), 'stream.d');
  }
  config.platform = platform;
  config.root = ROOT;
  config.configPath = configPath;
  config.dataDir = path.isAbsolute(config.dataDir) ? config.dataDir : path.join(ROOT, config.dataDir);
  return config;
}

module.exports = { load, buildDefaults, DEFAULTS, ROOT };
