'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { parseCookies, SESSION_COOKIE } = require('../core/auth');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PUBLIC_API = new Set(['/api/health', '/api/auth/login', '/api/auth/me']);

function createServer(deps) {
  const { config, logger } = deps;
  const routes = buildRoutes(deps);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      if (url.pathname.startsWith('/api/')) {
        // 每个 API 请求都记一行：排查「点了没反应」时，先看请求有没有到服务端
        const started = Date.now();
        res.on('finish', () => {
          const line = `${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`;
          if (res.statusCode >= 500) logger.error(line);
          else if (res.statusCode >= 400) logger.warn(line);
          else logger.info(line);
        });
        const authState = authenticate(req, url, config, deps.auth);
        if (!PUBLIC_API.has(url.pathname) && !authState) {
          return sendJson(res, 401, {
            error: '未登录或凭据无效',
            requiresLogin: true,
            hasUsers: deps.auth.hasUsers(),
          });
        }
        return await handleApi({ req, res, url, routes, deps, authState });
      }
      return serveStatic(req, res, url);
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) logger.error(`${req.method} ${req.url} 失败`, err);
      return sendJson(res, status, { error: err.message, errors: err.errors, steps: err.steps });
    }
  });

  server.on('clientError', (err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

function buildRoutes(deps) {
  const api = require('./api')(deps);
  const definitions = [
    ['GET', '/api/health', api.health],
    ['GET', '/api/auth/me', api.me],
    ['POST', '/api/auth/login', api.login],
    ['POST', '/api/auth/logout', api.logout],
    ['POST', '/api/auth/password', api.changePassword],
    ['GET', '/api/auth/users', api.listUsers],
    ['POST', '/api/auth/users', api.upsertUser],
    ['DELETE', '/api/auth/users/:username', api.deleteUser],

    ['GET', '/api/status', api.status],
    ['GET', '/api/platform', api.platform],
    ['POST', '/api/setup/include', api.setupInclude],
    ['GET', '/api/settings/healthcheck', api.getHealthSettings],
    ['PUT', '/api/settings/healthcheck', api.updateHealthSettings],
    ['GET', '/api/sites', api.listSites],
    ['POST', '/api/sites', api.createSite],
    ['POST', '/api/sites/apply-all', api.applyAllSites],
    ['GET', '/api/streams', api.listStreams],
    ['POST', '/api/streams', api.createStream],
    ['POST', '/api/streams/apply-all', api.applyAllStreams],
    ['GET', '/api/streams/:id', api.getStream],
    ['PUT', '/api/streams/:id', api.updateStream],
    ['DELETE', '/api/streams/:id', api.deleteStream],
    ['POST', '/api/streams/:id/apply', api.applyStream],
    ['POST', '/api/setup/stream-include', api.setupStreamInclude],
    ['POST', '/api/sites/prune', api.pruneConfFiles],
    ['GET', '/api/sites/:id', api.getSite],
    ['PUT', '/api/sites/:id', api.updateSite],
    ['DELETE', '/api/sites/:id', api.deleteSite],
    ['GET', '/api/sites/:id/preview', api.previewSite],
    ['POST', '/api/sites/:id/apply', api.applySite],
    ['POST', '/api/sites/:id/certificate', api.issueCertificate],
    ['POST', '/api/sites/:id/health', api.healthCheckSite],
    ['GET', '/api/sites/:id/logs', api.siteLogs],
    ['GET', '/api/sites/:id/errors', api.siteErrors],

    ['GET', '/api/certificates', api.listCertificates],
    ['DELETE', '/api/certificates/:name', api.deleteCertificate],
    ['POST', '/api/certificates/renew', api.renewCertificates],

    ['GET', '/api/logs', api.globalLogs],
    ['GET', '/api/backups', api.listBackups],
    ['POST', '/api/backups', api.createBackup],
    ['POST', '/api/backups/:id/restore', api.restoreBackup],
    ['DELETE', '/api/backups/:id', api.deleteBackup],
  ];

  return definitions.map(([method, pattern, handler]) => {
    const keys = [];
    const regex = new RegExp(
      `^${pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    return { method, regex, keys, handler };
  });
}

async function handleApi({ req, res, url, routes, deps, authState }) {
  const match = routes.find((route) => route.method === req.method && route.regex.test(url.pathname));
  if (!match) return sendJson(res, 404, { error: `未找到路由 ${req.method} ${url.pathname}` });

  const params = {};
  const values = match.regex.exec(url.pathname).slice(1);
  match.keys.forEach((key, index) => {
    params[key] = decodeURIComponent(values[index]);
  });

  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
  const query = Object.fromEntries(url.searchParams.entries());
  const result = await match.handler({ params, query, body, req, res, deps, authState });

  if (res.writableEnded) return undefined;
  if (result === undefined) return sendJson(res, 204, null);
  const status = result.status || 200;
  return sendJson(res, status, result.body !== undefined ? result.body : result);
}

function authenticate(req, url, config, auth) {
  const cookies = parseCookies(req.headers.cookie);
  const session = auth.validate(cookies[SESSION_COOKIE]);
  if (session) return { mode: 'session', username: session.username };

  const token = config.panel.authToken;
  if (token) {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    // 新头 x-fanproxy-token 优先，旧头 x-fan-token 继续兼容
    const candidate = bearer || req.headers['x-fanproxy-token'] || req.headers['x-fan-token'] || url.searchParams.get('token') || '';
    if (candidate && candidate.length === token.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token))) {
      return { mode: 'token', username: 'token' };
    }
  }

  if (!token && !auth.hasUsers()) return { mode: 'open', username: 'anonymous' };
  return null;
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error(`请求体不是合法 JSON: ${err.message}`), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(WEB_DIR, path.normalize(rel));
  if (!file.startsWith(WEB_DIR)) return sendJson(res, 403, { error: '非法路径' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return sendJson(res, 404, { error: '资源不存在' });
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  return undefined;
}

function sendJson(res, status, payload) {
  const body = payload === null ? '' : `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
  return undefined;
}

module.exports = { createServer };
