#!/usr/bin/env bash
# 冒烟测试：用桩程序替代 nginx/certbot，验证面板 API 与配置生成流程。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/fanproxy-smoke.XXXXXX)"
PORT="${FAN_SMOKE_PORT:-43111}"
BASE="http://127.0.0.1:${PORT}"
mkdir -p "$WORK/bin" "$WORK/nginx/sites" "$WORK/webroot" "$WORK/live" "$WORK/data" "$WORK/log"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/bin/nginx" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  -v) echo "nginx version: nginx/1.24.0 (stub)" >&2; exit 0 ;;
  -t) echo "nginx: configuration file test is successful" >&2; exit 0 ;;
  *)  echo "nginx stub: $*" >&2; exit 0 ;;
esac
STUB

cat > "$WORK/bin/certbot" <<'STUB'
#!/usr/bin/env bash
LIVE="${FAN_STUB_LIVE_DIR:?}"
case "${1:-}" in
  --version) echo "certbot 2.11.0 (stub)"; exit 0 ;;
  renew) echo "No renewals were attempted."; exit 0 ;;
  delete) echo "Removed certificate"; exit 0 ;;
  certificates)
    echo "Found the following certs:"
    for d in "$LIVE"/*/; do
      [ -d "$d" ] || continue
      name="$(basename "$d")"
      echo "  Certificate Name: $name"
      echo "    Domains: $name"
      echo "    Expiry Date: 2027-01-01 00:00:00+00:00 (VALID: 300 days)"
    done
    exit 0 ;;
esac
domain=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d) domain="${2:-}"; break ;;
  esac
  shift
done
mkdir -p "${LIVE}/${domain}"
echo "-----BEGIN CERTIFICATE-----stub" > "${LIVE}/${domain}/fullchain.pem"
echo "-----BEGIN CERTIFICATE-----stub" > "${LIVE}/${domain}/cert.pem"
echo "-----BEGIN PRIVATE KEY-----stub"   > "${LIVE}/${domain}/privkey.pem"
echo "Successfully received certificate for ${domain}"
STUB
chmod +x "$WORK/bin/nginx" "$WORK/bin/certbot"

cat > "$WORK/config.json" <<JSON
{
  "panel": { "host": "127.0.0.1", "port": ${PORT}, "authToken": "", "adminPassword": "" },
  "nginx": { "bin": "$WORK/bin/nginx", "mainConf": "$WORK/nginx.conf", "sitesDir": "$WORK/nginx/sites", "logDir": "$WORK/log" },
  "certbot": { "bin": "$WORK/bin/certbot", "webroot": "$WORK/webroot", "liveDir": "$WORK/live", "email": "ops@example.com" },
  "scheduler": { "enabled": false, "intervalMinutes": 720 },
  "backup": { "enabled": true, "keep": 2 },
  "dataDir": "$WORK/data",
  "logLevel": "info"
}
JSON
echo "include $WORK/nginx/sites/*.conf;" > "$WORK/nginx.conf"

export FAN_STUB_LIVE_DIR="$WORK/live"
FAN_CONFIG="$WORK/config.json" node "$ROOT/bin/fanproxy.js" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  curl -sf "$BASE/api/health" >/dev/null && break
  sleep 0.2
done

say() { printf '\n=== %s ===\n' "$1"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

say "健康检查"
curl -sf "$BASE/api/health" | json 'JSON.stringify(j)'

say "环境状态"
curl -sf "$BASE/api/status" | json '`nginx=${j.nginx.installed} certbot=${j.certbot.installed} include=${j.nginx.include.ok}`'

say "创建站点"
SITE_ID="$(curl -sf -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{
  "name": "示例站点",
  "serverNames": ["example.com", "www.example.com"],
  "upstream": { "host": "127.0.0.1", "port": 8080, "websocket": true }
}' | json 'j.site.id')"
echo "site id = $SITE_ID"

say "申请证书（桩）"
curl -sf -X POST "$BASE/api/sites/$SITE_ID/certificate" -H 'Content-Type: application/json' -d '{}' \
  | json '`ok=${j.ok} certPath=${j.site && j.site.ssl.certPath}`'

say "勾选 HTTPS 保存自动签发"
AUTO_JSON="$(curl -sf -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{
  "name": "自动 HTTPS 站点",
  "serverNames": ["auto.example.com"],
  "ssl": { "enabled": true },
  "upstream": { "host": "127.0.0.1", "port": 8080 }
}')"
AUTO_ID="$(printf '%s' "$AUTO_JSON" | json 'j.site.id')"
printf '%s' "$AUTO_JSON" | json '`ssl=${j.site.ssl.enabled} certPath=${j.site.ssl.certPath} reused=${j.issued && j.issued.reused} issued=${j.issued && j.issued.ok}`'

say "证书列表（关联站点）"
curl -sf "$BASE/api/certificates" | json '`certs=${j.certificates.length} ` + j.certificates.map((c) => c.name + ":sites=" + (c.sites || []).length + ":staging=" + c.staging).join(" ")'

say "多张证书都要出现在列表里"
curl -sf "$BASE/api/certificates" | json 'j.certificates.length >= 2
  ? "证书列表完整: " + j.certificates.map((c) => c.name).join(",")
  : (function () { throw new Error("证书列表只有 " + j.certificates.length + " 条，应为 2 条"); })()'

say "每个站点独立 conf，互不覆盖"
node -e '
const fs = require("fs");
const path = require("path");
const store = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((name) => name.endsWith(".conf"));
const bad = [];
for (const site of store.sites) {
  const file = path.join(dir, site.confFile);
  const head = fs.existsSync(file) ? fs.readFileSync(file, "utf8").slice(0, 300) : "";
  if (!head.includes("(" + site.id + ")")) bad.push(site.name + " -> " + site.confFile);
}
console.log("站点 " + store.sites.length + " 个，conf " + files.length + " 个" + (bad.length ? "，错配: " + bad.join(", ") : ""));
if (bad.length || files.length !== store.sites.length) process.exit(1);
' "$WORK/data/sites.json" "$WORK/nginx/sites"

say "仅 HTTPS 站点：配置里不再监听 80"
curl -sf -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{
  "name": "仅 HTTPS 站点",
  "serverNames": ["secure.example.com"],
  "httpEnabled": false,
  "ssl": { "enabled": true },
  "upstream": { "host": "127.0.0.1", "port": 8080 }
}' | json '`ssl=${j.site.ssl.enabled} httpEnabled=${j.site.httpEnabled} issued=${j.issued && j.issued.ok}`'
SECURE_CONF="$WORK/nginx/sites/fanproxy-secure.example.com.conf"
grep -n "listen" "$SECURE_CONF"
if grep -q "listen 80" "$SECURE_CONF"; then
  echo "失败：仅 HTTPS 站点仍在监听 80 端口"
  exit 1
fi
echo "已确认：只监听 443"

say "关闭 HTTP 却没启用 HTTPS（应被拒绝）"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{
  "name": "非法站点",
  "serverNames": ["bad.example.com"],
  "httpEnabled": false,
  "upstream": { "host": "127.0.0.1", "port": 8080 }
}'

say "删除被站点引用的证书（应被拒绝）"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X DELETE "$BASE/api/certificates/auto.example.com"

say "取消启用 HTTPS 后证书自动解除关联"
curl -sf -X PUT "$BASE/api/sites/$AUTO_ID" -H 'Content-Type: application/json' \
  -d '{ "ssl": { "enabled": false } }' \
  | json '`ssl=${j.site.ssl.enabled} certPath="${j.site.ssl.certPath}"`'
curl -sf "$BASE/api/certificates" | json '`certs=${j.certificates.length} ` + j.certificates.map((c) => c.name + ":sites=" + (c.sites || []).length).join(" ")'

say "删除无关联证书"
curl -sf -X DELETE "$BASE/api/certificates/auto.example.com" | json '`ok=${j.ok} detail=${j.detail}`'

say "泛域名签发失败时站点仍按 HTTP 保存"
curl -sf -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{
  "name": "泛域名站点",
  "serverNames": ["*.wild.example.com"],
  "ssl": { "enabled": true },
  "upstream": { "host": "127.0.0.1", "port": 8080 }
}' | json '`ssl=${j.site.ssl.enabled} issued=${j.issued && j.issued.ok} step=${j.issued && j.issued.steps.slice(-1)[0].step}`'

say "续期检查（桩）"
curl -sf -X POST "$BASE/api/certificates/renew" | json '`ok=${j.ok} detail=${j.detail}`'

say "续期时为仅 HTTPS 站点临时放通 80，续期后恢复"
if grep -q "续期前临时放通 80 端口" "$WORK/server.log"; then echo "续期时已临时放通 80 端口"; else echo "失败：续期没有临时放通 80 端口"; exit 1; fi
if grep -q "listen 80" "$SECURE_CONF"; then echo "失败：续期后没有恢复「仅 HTTPS」"; exit 1; fi
echo "续期后已恢复：只监听 443"

say "手动快照永久保留（不计入自动快照上限）"
MANUAL_ID="$(curl -sf -X POST "$BASE/api/backups" -H 'Content-Type: application/json' -d '{ "reason": "手动留存" }' | json 'j.id')"
echo "manual id = $MANUAL_ID"
for _ in 1 2 3 4; do curl -sf -X POST "$BASE/api/sites/apply-all" >/dev/null; done
BACKUP_JSON="$(curl -sf "$BASE/api/backups?limit=200")"
printf '%s' "$BACKUP_JSON" | json '`自动=${j.counts.auto}/${j.keep} 手动=${j.counts.manual} 手动带标记=${j.backups.filter((b) => b.manual).length}`'
if printf '%s' "$BACKUP_JSON" | grep -q "$MANUAL_ID"; then
  echo "手动快照 $MANUAL_ID 仍在列表中（永久保留）"
else
  echo "失败：手动快照被自动裁剪掉了"
  exit 1
fi
printf '%s' "$BACKUP_JSON" | json 'j.counts.auto <= j.keep ? "自动快照未超限: " + j.counts.auto + "/" + j.keep : (function () { throw new Error("自动快照 " + j.counts.auto + " 份，超过 keep=" + j.keep); })()'

say "健康检查设置可读写"
curl -sf "$BASE/api/settings/healthcheck" | json '`enabled=${j.healthcheck.enabled} interval=${j.healthcheck.intervalSeconds} timeout=${j.healthcheck.timeoutMs}`'
curl -sf -X PUT "$BASE/api/settings/healthcheck" -H 'Content-Type: application/json' \
  -d '{ "intervalSeconds": 30, "timeoutMs": 1500 }' \
  | json '`saved interval=${j.healthcheck.intervalSeconds} timeout=${j.healthcheck.timeoutMs} enabled=${j.healthcheck.enabled}`'
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X PUT "$BASE/api/settings/healthcheck" -H 'Content-Type: application/json' -d '{ "intervalSeconds": 1 }'

say "手动探测写入健康历史"
curl -sf -X POST "$BASE/api/sites/$SITE_ID/health" | json '`ok=${j.ok} target=${j.target} history=${j.history.length} last=${j.history.slice(-1)[0].ok}`'

say "站点列表带健康历史"
curl -sf "$BASE/api/sites" | json 'j.sites.map((s) => s.name + ":history=" + ((s.history || []).length) + ":health=" + Boolean(s.health)).join(" ")'

say "健康历史最多保留 20 条"
for _ in $(seq 1 25); do curl -sf -X POST "$BASE/api/sites/$SITE_ID/health" >/dev/null; done
MAXH="$(curl -sf "$BASE/api/sites" | json 'Math.max(...j.sites.map((s) => s.history.length))')"
if [[ "$MAXH" == "20" ]]; then echo "历史上限 20 条，当前 $MAXH"; else echo "失败：历史上限不是 20（当前 $MAXH）"; exit 1; fi

say "IPv6 上游：[::1] 能正确渲染并能探测"
IPV6_ID="$(curl -sf -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{
  "name": "IPv6 站点",
  "serverNames": ["v6.example.com"],
  "upstream": { "host": "[::1]", "port": 8080 }
}' | json 'j.site.id')"
curl -sf "$BASE/api/sites/$IPV6_ID/preview" | json 'j.config.split("\n").find((l) => l.includes("proxy_pass")).trim()'
curl -sf -X POST "$BASE/api/sites/$IPV6_ID/health" | json '`target=${j.target} err=${j.tcp.error || "(tcp 通)"}`'
curl -sf -X POST "$BASE/api/sites/$IPV6_ID/health" | json '/ENOTFOUND/.test(JSON.stringify(j)) ? (function () { throw new Error("IPv6 地址没有被正确解析: " + j.tcp.error); })() : "OK：探测不再出现 ENOTFOUND"'

say "gRPC 站点：生成 grpc_pass 并开启 HTTP/2"
GRPC_ID="$(curl -sf -X POST "$BASE/api/sites" -H 'Content-Type: application/json' -d '{
  "name": "gRPC 站点",
  "serverNames": ["grpc.example.com"],
  "ssl": { "enabled": true },
  "upstream": { "scheme": "grpc", "host": "127.0.0.1", "port": 50051 }
}' | json 'j.site.id')"
GRPC_CONF="$WORK/nginx/sites/fanproxy-grpc.example.com.conf"
grep -nE "listen|http2|grpc_" "$GRPC_CONF"
grep -q "grpc_pass grpc://127.0.0.1:50051;" "$GRPC_CONF" || { echo "失败：没有生成 grpc_pass"; exit 1; }
grep -q 'grpc_set_header Host $host;' "$GRPC_CONF" || { echo "失败：没有生成 grpc_set_header"; exit 1; }
grep -q "http2" "$GRPC_CONF" || { echo "失败：gRPC 站点没有开启 HTTP/2"; exit 1; }
if grep -q "proxy_pass" "$GRPC_CONF"; then echo "失败：gRPC 站点不应出现 proxy_pass"; exit 1; fi
echo "已确认：grpc_pass + grpc_set_header + http2"

say "gRPC 上游健康探测只做 TCP（不会因 HTTP/1.1 探测误报）"
curl -sf -X POST "$BASE/api/sites/$GRPC_ID/health" | json '`ok=${j.ok} tcp=${j.tcp.error || "(通)"} note=${j.note || "-"} http=${j.http === null ? "null" : JSON.stringify(j.http)}`'

say "TCP 转发：新建规则生成 stream 配置"
STREAM_JSON="$(curl -sf -X POST "$BASE/api/streams" -H 'Content-Type: application/json' -d '{
  "name": "NAS 设备空间",
  "protocol": "tcp",
  "listenPort": 8443,
  "backend": { "host": "192.168.101.188", "port": 5667 }
}')"
STREAM_ID="$(printf '%s' "$STREAM_JSON" | json 'j.stream.id')"
printf '%s' "$STREAM_JSON" | json '`applied=${j.applied.ok} conf=${j.stream.confFile}`'
STREAM_CONF="$WORK/nginx/stream.d/fanproxy-stream-nas-8443.conf"
grep -nE "^server|listen|proxy_pass|proxy_timeout" "$STREAM_CONF"
grep -q "^server {" "$STREAM_CONF" || { echo "失败：缺少裸 server 块"; exit 1; }
grep -q "proxy_pass 192.168.101.188:5667;" "$STREAM_CONF" || { echo "失败：缺少 proxy_pass"; exit 1; }
grep -q "^stream {" "$STREAM_CONF" && { echo "失败：转发 conf 自带 stream 块，第二条规则会撞 stream duplicate"; exit 1; }
echo "已确认：裸 server 块 + proxy_pass"

say "TCP 转发：include 自动落进 stream {} 块"
curl -sf "$BASE/api/streams" | json '`include=${j.include.ok} mode=${j.include.mode}`'
node -e '
const fs = require("fs");
const conf = fs.readFileSync(process.argv[1], "utf8");
const dir = process.argv[2];
const block = /^stream \{[\s\S]*?^\}/m.exec(conf);
if (!block) throw new Error("主配置里找不到顶层 stream 块");
if (!block[0].includes(dir + "/*.conf;")) throw new Error("include 不在 stream 块里: " + block[0].trim());
if (conf.replace(block[0], "").includes("stream.d")) throw new Error("顶层作用域还残留一份 include");
console.log("已确认：include 在 stream {} 块里，顶层无残留");
' "$WORK/nginx.conf" "$WORK/nginx/stream.d"

say "TCP 转发：第二条规则不撞 stream 重复（UDP + 监听地址 + IPv6 后端）"
curl -sf -X POST "$BASE/api/streams" -H 'Content-Type: application/json' -d '{
  "name": "DNS",
  "protocol": "udp",
  "listenAddress": "127.0.0.1",
  "listenPort": 15353,
  "backend": { "host": "[::1]", "port": 53 }
}' | json '`conf=${j.stream.confFile} ok=${j.applied.ok}`'
grep -nE "listen|proxy_pass" "$WORK/nginx/stream.d/fanproxy-stream-dns-15353.conf"
node -e '
const fs = require("fs");
const conf = fs.readFileSync(process.argv[1], "utf8");
const dir = process.argv[2];
const count = (conf.match(/^stream \{/gm) || []).length;
if (count !== 1) throw new Error("主配置里有 " + count + " 个顶层 stream 块（应为 1）");
const files = fs.readdirSync(dir).filter((name) => name.endsWith(".conf") && !name.includes("placeholder"));
const withBlock = files.filter((name) => /^stream \{/m.test(fs.readFileSync(dir + "/" + name, "utf8")));
if (withBlock.length) throw new Error("这些转发 conf 自带 stream 块: " + withBlock.join(", "));
console.log("已确认：1 个 stream 块 + " + files.length + " 个裸 server 配置");
' "$WORK/nginx.conf" "$WORK/nginx/stream.d"

say "TCP 转发：同端口冲突应被拒绝"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$BASE/api/streams" -H 'Content-Type: application/json' -d '{
  "name": "冲突规则", "listenPort": 8443, "backend": { "host": "127.0.0.1", "port": 80 }
}'

say "TCP 转发：include 已就绪时重复写入是幂等的"
curl -sf -X POST "$BASE/api/setup/stream-include" | json '`ok=${j.ok} already=${j.already} mode=${j.mode}`'

say "TCP 转发：旧版「顶层 include + 自带 stream 块」被自动迁移"
node -e '
const fs = require("fs");
const conf = process.argv[1];
const dir = process.argv[2];
const file = process.argv[3];
const text = fs.readFileSync(conf, "utf8");
fs.writeFileSync(conf, text.replace(/^stream \{[\s\S]*?^\}\n?/m, "") + "\n# fanproxy: TCP/UDP 转发（stream 模块）\ninclude " + dir + "/*.conf;\n", "utf8");
const body = fs.readFileSync(file, "utf8").split("\n").filter((line) => !line.startsWith("# 本文件只写"));
const start = body.findIndex((line) => line === "server {");
const inner = body.slice(start).map((line) => (line ? "    " + line : line));
fs.writeFileSync(file, [...body.slice(0, start), "stream {", ...inner].join("\n"), "utf8");
console.log("已还原成旧版形态：顶层 include + 自带 stream 块的转发 conf");
' "$WORK/nginx.conf" "$WORK/nginx/stream.d" "$STREAM_CONF"
grep -n "^stream {" "$STREAM_CONF" || { echo "失败：旧格式没造出来"; exit 1; }
curl -sf -X POST "$BASE/api/setup/stream-include" | json '`ok=${j.ok} mode=${j.mode} rewritten=${(j.rewritten || []).length}`'
grep -q "^stream {" "$STREAM_CONF" && { echo "失败：旧格式转发 conf 没有被迁移"; exit 1; }
node -e '
const fs = require("fs");
const conf = fs.readFileSync(process.argv[1], "utf8");
const count = (conf.match(/^stream \{/gm) || []).length;
if (count !== 1) throw new Error("迁移后主配置里有 " + count + " 个顶层 stream 块（应为 1）");
const block = /^stream \{[\s\S]*?^\}/m.exec(conf);
if (!block || !block[0].includes(process.argv[2] + "/*.conf;")) throw new Error("迁移后 include 不在 stream 块里");
if (conf.replace(block[0], "").includes("stream.d")) throw new Error("迁移后顶层作用域还残留一份 include");
console.log("已确认：旧格式已迁移，include 只剩 stream 块里那一份");
' "$WORK/nginx.conf" "$WORK/nginx/stream.d"

say "TCP 转发：conf 被删掉后能被补回来"
rm -f "$WORK/nginx/stream.d/fanproxy-stream-dns-15353.conf"
curl -sf -X POST "$BASE/api/setup/stream-include" | json '`ok=${j.ok} rewritten=${(j.rewritten || []).length}`'
[ -f "$WORK/nginx/stream.d/fanproxy-stream-dns-15353.conf" ] || { echo "失败：缺失的转发配置没有补回来"; exit 1; }
grep -q "^server {" "$WORK/nginx/stream.d/fanproxy-stream-dns-15353.conf" || { echo "失败：补回来的配置不是裸 server 块"; exit 1; }
echo "已确认：缺失的转发配置会被自动补回"

say "TCP 转发：停用移除该条配置，其它规则不受影响"
curl -sf -X POST "$BASE/api/streams/$STREAM_ID/apply" -H 'Content-Type: application/json' -d '{ "enabled": false }' | json '`enabled=${j.stream.enabled} ok=${j.ok}`'
ls "$WORK/nginx/stream.d"
[ -f "$STREAM_CONF" ] && { echo "失败：停用后配置还在"; exit 1; }
[ -f "$WORK/nginx/stream.d/fanproxy-stream-dns-15353.conf" ] || { echo "失败：其它规则被误删"; exit 1; }
echo "已确认：停用的规则配置已移除，其它规则保留"

say "TCP 转发：全部删完后自动补占位文件（避免 include 通配符为空）"
STREAM_IDS="$(curl -sf "$BASE/api/streams" | json 'j.streams.map((r) => r.id).join(" ")')"
for id in $STREAM_IDS; do curl -sf -X DELETE "$BASE/api/streams/$id" >/dev/null; done
ls "$WORK/nginx/stream.d"
curl -sf "$BASE/api/streams" | json '`rules=${j.streams.length}`'
[ -f "$WORK/nginx/stream.d/fanproxy-stream-placeholder.conf" ] || { echo "失败：缺少占位文件"; exit 1; }
echo "已确认：没有规则时目录里留占位文件"

say "生成的 nginx 配置"
curl -sf "$BASE/api/sites/$SITE_ID/preview" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).config))'

say "冒烟测试通过"
