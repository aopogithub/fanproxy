'use strict';

const path = require('node:path');

const { bracketed } = require('./hostutil');
const { isGrpc } = require('./protocol');

/** 托管配置的标识头：只有带这个标记的文件才会被 fanproxy 覆盖或清理。 */
const MANAGED_MARKER = '# 由 fanproxy 自动生成，请勿手工修改';
/** 改名（fan）之前写下的标记，旧文件仍按托管文件对待，避免变成「用户文件」而被重复创建。 */
const LEGACY_MARKERS = ['# 由 fan 自动生成，请勿手工修改'];

/** 判断一份 conf 是否由面板生成（兼容旧标记）。 */
function isManaged(head) {
  return head.includes(MANAGED_MARKER) || LEGACY_MARKERS.some((marker) => head.includes(marker));
}

/** 判断一份托管 conf 是不是这个站点自己的（靠 `# site: <名称> (<id>)` 里的 id）。 */
function managedBy(head, site) {
  if (!site || !site.id || !isManaged(head)) return false;
  return head.includes(`(${site.id})`);
}

/** 生成 nginx server 配置。所有输出都带标识头，重复渲染是幂等的。 */
function render(site, config) {
  const blocks = [];
  const isHttps = site.ssl.enabled;
  // 「关闭 HTTP」只在 HTTPS 已生效时才成立：签发/续期需要 80 端口做 ACME 校验，
  // 没有证书时若也不监听 80，站点就彻底不可访问了。
  const skipHttp = isHttps && site.httpEnabled === false;

  if (!skipHttp) blocks.push(renderHttpBlock(site, config, isHttps));
  if (isHttps) blocks.push(renderHttpsBlock(site, config));

  return [
    MANAGED_MARKER,
    `# site: ${site.name} (${site.id})`,
    `# updated: ${site.updatedAt}`,
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}

function renderHttpBlock(site, config, isHttps) {
  const logs = logPaths(site, config);
  const lines = [
    'server {',
    // gRPC 明文（h2c）需要在这个端口上开 HTTP/2；走 HTTPS 时这里只做跳转，不用开
    ...listenLines(config, site.listenHttp, { http2: isGrpc(scheme(site)) && !isHttps }),
    `    server_name ${site.serverNames.join(' ')};`,
    '',
    `    access_log ${logs.access};`,
    `    error_log ${logs.error};`,
    '',
    '    location /.well-known/acme-challenge/ {',
    `        root ${config.certbot.webroot};`,
    '        default_type "text/plain";',
    '    }',
  ];

  if (isHttps) {
    lines.push('', '    location / {', '        return 301 https://$host$request_uri;', '    }');
  } else {
    lines.push('', ...proxyBlock(site));
  }

  lines.push('}');
  return lines.join('\n');
}

function renderHttpsBlock(site, config) {
  const logs = logPaths(site, config);
  return [
    'server {',
    ...listenLines(config, site.listenHttps, { ssl: true, http2: isGrpc(scheme(site)) }),
    `    server_name ${site.serverNames.join(' ')};`,
    '',
    `    ssl_certificate ${site.ssl.certPath};`,
    `    ssl_certificate_key ${site.ssl.keyPath};`,
    '    ssl_session_cache shared:SSL:10m;',
    '    ssl_session_timeout 10m;',
    '    ssl_protocols TLSv1.2 TLSv1.3;',
    '    ssl_prefer_server_ciphers off;',
    '',
    '    add_header Strict-Transport-Security "max-age=31536000" always;',
    '',
    `    access_log ${logs.access};`,
    `    error_log ${logs.error};`,
    '',
    '    location /.well-known/acme-challenge/ {',
    `        root ${config.certbot.webroot};`,
    '        default_type "text/plain";',
    '    }',
    '',
    ...proxyBlock(site),
    '}',
  ].join('\n');
}

function proxyBlock(site) {
  const lines = ['    location / {', ...upstreamLines(site)];

  if (site.upstream.websocket && !isGrpc(scheme(site))) {
    lines.push(
      '        proxy_set_header Upgrade $http_upgrade;',
      '        proxy_set_header Connection "upgrade";',
      '        proxy_read_timeout 3600s;',
    );
  }

  for (const header of site.advanced.extraHeaders) {
    lines.push(`        add_header ${header} always;`);
  }

  lines.push('    }');

  if (site.advanced.extraLocations) {
    lines.push('', indent(site.advanced.extraLocations, 4));
  }

  return lines;
}

/** 上游协议（已归一化）。 */
function scheme(site) {
  return site.upstream.scheme || 'http';
}

/**
 * gRPC 用 grpc_pass（HTTP/2 长连接），普通 HTTP 用 proxy_pass。
 * 两者都带上客户端信息头，便于上游识别真实来源。
 */
function upstreamLines(site) {
  const target = `${scheme(site)}://${bracketed(site.upstream.host)}:${site.upstream.port}`;
  if (isGrpc(scheme(site))) {
    return [
      `        grpc_pass ${target};`,
      '        grpc_set_header Host $host;',
      '        grpc_set_header X-Real-IP $remote_addr;',
      '        grpc_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        grpc_set_header X-Forwarded-Proto $scheme;',
      '        grpc_read_timeout 300s;',
      '        grpc_send_timeout 300s;',
      `        client_max_body_size ${site.advanced.clientMaxBodySize};`,
    ];
  }
  return [
    `        proxy_pass ${target};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    `        client_max_body_size ${site.advanced.clientMaxBodySize};`,
  ];
}

/**
 * listen 行。gRPC 需要 HTTP/2：
 * - nginx 1.25.1 起 `listen ... http2` 已废弃，改用 `http2 on;`
 * - 更老的版本（CentOS 7 的 nginx 1.20 等）只认 `listen ... http2`
 * 版本探测结果放在 config.nginx.http2Directive，探测不到时用兼容写法。
 */
function listenLines(config, port, { ssl = false, http2 = false } = {}) {
  const useDirective = http2 && config?.nginx?.http2Directive === true;
  const flags = [ssl ? 'ssl' : '', http2 && !useDirective ? 'http2' : ''].filter(Boolean).join(' ');
  const suffix = flags ? ` ${flags}` : '';
  const lines = [`    listen ${port}${suffix};`, `    listen [::]:${port}${suffix};`];
  if (useDirective) lines.push('    http2 on;');
  return lines;
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return String(text).split('\n').map((line) => (line.trim() ? pad + line.trim() : line)).join('\n');
}

/**
 * 每个代理站点在 nginx 配置目录下单独持有一个配置文件。
 * 文件名取自首个域名（去掉通配符），默认加 fanproxy- 前缀，便于在 conf.d 里辨认。
 */
function confFileName(site, config) {
  if (site.confFile) return site.confFile;
  const prefix = config.nginx.filePrefix === undefined ? 'fanproxy-' : config.nginx.filePrefix;
  return `${prefix}${slug(site)}.conf`;
}

function slug(site) {
  const primary = (site.serverNames || [])[0] || site.name || 'site';
  const cleaned = primary
    .replace(/^\*\./, '')
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .toLowerCase();
  return cleaned || 'site';
}

function confPath(site, config) {
  return path.join(config.nginx.sitesDir, confFileName(site, config));
}

/* ---------- TCP/UDP 转发（nginx stream 模块） ---------- */

/**
 * 生成一个 stream 转发规则。
 * 注意：nginx 只允许一个顶层 stream {} 块（和 http {} 平级），所以这里只写裸 server 块，
 * `stream { include <streamDir>/*.conf; }` 由主配置负责（manager.setupStreamInclude）。
 * 每条规则各自带一个 stream {} 会撞 "stream directive is duplicate"。
 */
function renderStream(rule, config) {
  const udp = rule.protocol === 'udp' ? ' udp' : '';
  const lines = [
    MANAGED_MARKER,
    `# stream: ${rule.name || rule.listenPort} (${rule.id})`,
    `# updated: ${rule.updatedAt}`,
    '# 本文件只写 server 块：stream {}/include 由 nginx 主配置负责，多个规则共用一个 stream 块',
    '',
    'server {',
    `    listen ${rule.listenAddress ? `${rule.listenAddress}:` : ''}${rule.listenPort}${udp};`,
  ];
  if (!rule.listenAddress) lines.push(`    listen [::]:${rule.listenPort}${udp};`);
  lines.push(
    `    proxy_pass ${bracketed(rule.backend.host)}:${rule.backend.port};`,
    `    proxy_connect_timeout ${rule.connectTimeoutSeconds}s;`,
    `    proxy_timeout ${rule.proxyTimeoutSeconds}s;`,
    '}',
    '',
  );
  return lines.join('\n');
}

/** 转发规则的配置文件：fanproxy-stream-<名称>-<端口>.conf，便于在 stream.d 里辨认。 */
function streamConfFileName(rule, config) {
  if (rule.confFile) return rule.confFile;
  const prefix = config.nginx.filePrefix === undefined ? 'fanproxy-' : config.nginx.filePrefix;
  const name = streamSlug(rule.name) || 'tcp';
  return `${prefix}stream-${name}-${rule.listenPort || 0}.conf`;
}

function streamConfPath(rule, config) {
  return path.join(config.nginx.streamDir, streamConfFileName(rule, config));
}

/** 占位文件：stream 目录为空时，`include dir/*.conf;` 会让 nginx 报错，用它顶住。 */
function streamPlaceholderName(config) {
  const prefix = config.nginx.filePrefix === undefined ? 'fanproxy-' : config.nginx.filePrefix;
  return `${prefix}stream-placeholder.conf`;
}

function streamPlaceholderContent() {
  return [
    MANAGED_MARKER,
    '# stream: 占位文件（没有任何 TCP 转发规则）',
    '# fanproxy: 目录为空时 include 通配符会让 nginx -t 失败，这里放一个空配置顶住',
    '',
  ].join('\n');
}

function streamSlug(name) {
  return String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .toLowerCase()
    .slice(0, 40);
}

/** 站点日志路径，renderer 与 logs 模块共用，避免两处逻辑漂移。 */
function logPaths(site, config) {
  const dir = path.join(config.nginx.logDir, 'fanproxy');
  return {
    access: site.advanced?.accessLog || path.join(dir, `${site.id}.access.log`),
    error: site.advanced?.errorLog || path.join(dir, `${site.id}.error.log`),
  };
}

module.exports = {
  render,
  confPath,
  confFileName,
  logPaths,
  renderStream,
  streamConfFileName,
  streamConfPath,
  streamPlaceholderName,
  streamPlaceholderContent,
  MANAGED_MARKER,
  isManaged,
  managedBy,
};
