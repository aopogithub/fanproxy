'use strict';

/**
 * 上游协议。
 * http/https 走 nginx 的 proxy_pass；grpc/grpcs 走 grpc_pass（gRPC 需要 HTTP/2）。
 */
const UPSTREAM_SCHEMES = ['http', 'https', 'grpc', 'grpcs'];
const GRPC_SCHEMES = new Set(['grpc', 'grpcs']);

function isGrpc(scheme) {
  return GRPC_SCHEMES.has(String(scheme || '').trim().toLowerCase());
}

/** 未知/空值统一回落到 http，避免把非法协议写进 nginx 配置。 */
function normalizeScheme(scheme) {
  const text = String(scheme || '').trim().toLowerCase();
  return UPSTREAM_SCHEMES.includes(text) ? text : 'http';
}

module.exports = { UPSTREAM_SCHEMES, isGrpc, normalizeScheme };
