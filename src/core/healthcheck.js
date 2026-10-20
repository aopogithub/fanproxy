'use strict';

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const { bracketed, forConnect, hostHeader } = require('./hostutil');
const { isGrpc } = require('./protocol');

/** 上游健康检查：TCP 连通性 + 可选 HTTP 状态探测。 */
async function checkSite(site, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 3000;
  const { host, port, scheme } = site.upstream;
  // IPv6 字面量在面板里常写成 [::1]，连接与 Host 头需要不同形式
  const connectHost = forConnect(host);
  const started = Date.now();

  const tcp = await tcpProbe(connectHost, port, timeoutMs);
  const result = {
    siteId: site.id,
    name: site.name,
    target: `${scheme}://${bracketed(host)}:${port}`,
    ok: tcp.ok,
    latencyMs: Date.now() - started,
    tcp,
    http: null,
    checkedAt: new Date().toISOString(),
  };

  // gRPC 上游只讲 HTTP/2，发 HTTP/1.1 请求必然失败，因此只做 TCP 连通性检查
  if (isGrpc(scheme)) {
    result.note = 'gRPC 上游只做 TCP 探测';
    return result;
  }

  const probePath = options.path || site.advanced?.healthCheckPath || '';
  if (!probePath) return result;

  const httpResult = await httpProbe(scheme, connectHost, port, probePath, timeoutMs);
  result.http = httpResult;
  result.ok = tcp.ok && httpResult.ok;
  result.status = httpResult.status;
  return result;
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect(connectOptions(host, port));
    let settled = false;

    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - started, error: error || null });
    };

    socket.setTimeout(timeoutMs, () => done(false, `连接超时 ${timeoutMs}ms`));
    socket.on('connect', () => done(true));
    socket.on('error', (err) => done(false, err.message));
  });
}

/**
 * 双栈回退：域名同时有 A / AAAA 时，只要有一个能连上就算通。
 * Node 20 起默认开启，18.13 起提供开关；更低版本只能靠 DNS 顺序，保持默认行为。
 */
function connectOptions(host, port) {
  const options = { host, port };
  if (typeof net.setDefaultAutoSelectFamily === 'function') options.autoSelectFamily = true;
  return options;
}

function httpProbe(scheme, host, port, path, timeoutMs) {
  return new Promise((resolve) => {
    const client = scheme === 'https' ? https : http;
    const started = Date.now();
    const headers = {};
    const hostValue = hostHeader(host, port);
    if (hostValue) headers.Host = hostValue;
    const req = client.request(
      { ...connectOptions(host, port), path, method: 'GET', timeout: timeoutMs, rejectUnauthorized: false, headers },
      (res) => {
        res.resume();
        resolve({
          ok: res.statusCode !== undefined && res.statusCode < 500,
          status: res.statusCode,
          latencyMs: Date.now() - started,
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, latencyMs: Date.now() - started, error: `请求超时 ${timeoutMs}ms` });
    });
    req.on('error', (err) => resolve({ ok: false, status: null, latencyMs: Date.now() - started, error: err.message }));
    req.end();
  });
}

module.exports = { checkSite };
