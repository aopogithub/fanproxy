'use strict';

const net = require('node:net');

/**
 * 上游地址的 IPv6 处理。
 * 面板/nginx 里 IPv6 字面量习惯写成 `[::1]`，而 socket / DNS 只认不带方括号的 `::1`；
 * HTTP 的 Host 头又必须带方括号。这里统一转换，避免各处各自判断。
 */

/** 去掉 IPv6 字面量的方括号：[::1] -> ::1；域名与 IPv4 原样返回（去掉首尾空白）。 */
function bare(host) {
  const text = String(host ?? '').trim();
  if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1).trim();
  return text;
}

/** 是否是 IPv6 字面量（`[::1]`、`::1`、`fe80::1%eth0` 都算）。 */
function isIpv6(host) {
  return net.isIPv6(bare(host));
}

/** 写进 nginx / URL 的形式：IPv6 补上方括号，其它原样。 */
function bracketed(host) {
  const text = bare(host);
  return net.isIPv6(text) ? `[${text}]` : text;
}

/** socket / DNS 使用的形式。 */
function forConnect(host) {
  return bare(host);
}

/** HTTP Host 头：IPv6 需要方括号，其它返回 null 表示用 Node 默认行为。 */
function hostHeader(host, port) {
  const text = bare(host);
  if (!net.isIPv6(text)) return null;
  return `[${text}]:${port}`;
}

module.exports = { bare, isIpv6, bracketed, forConnect, hostHeader };
