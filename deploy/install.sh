#!/usr/bin/env bash
# fanproxy 安装脚本：自动识别发行版与初始化系统，Node.js >= 20 需要预先安装。
#
# 用法：
#   sudo bash deploy/install.sh              # 补齐缺失依赖（已装的跳过）+ 部署 + 注册服务
#   SKIP_DEPS=1 sudo bash deploy/install.sh  # 只部署，不动系统包
#   PREFIX=/opt/fanproxy CONF_DIR=/etc/fanproxy bash deploy/install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${PREFIX:-/opt/fanproxy}"
CONF_DIR="${CONF_DIR:-/etc/fanproxy}"
SKIP_DEPS="${SKIP_DEPS:-0}"
MIN_NODE_MAJOR="${MIN_NODE_MAJOR:-16}"

log()  { printf '[fanproxy] %s\n' "$*"; }
warn() { printf '[fanproxy] 警告: %s\n' "$*" >&2; }
die()  { printf '[fanproxy] 错误: %s\n' "$*" >&2; exit 1; }

# 检测可执行文件：先看 PATH，再看常见目录（CentOS 的部分 shell PATH 里没有 /usr/sbin）
BIN_DIRS=(/usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin)
have_bin() {
  command -v "$1" >/dev/null 2>&1 && return 0
  local dir
  for dir in "${BIN_DIRS[@]}"; do
    [[ -x "$dir/$1" ]] && return 0
  done
  return 1
}

# 已安装时的可执行文件路径（用于日志展示）
bin_path() {
  local p
  p="$(command -v "$1" 2>/dev/null || true)"
  if [[ -n "$p" ]]; then printf '%s' "$p"; return 0; fi
  local dir
  for dir in "${BIN_DIRS[@]}"; do
    if [[ -x "$dir/$1" ]]; then printf '%s/%s' "$dir" "$1"; return 0; fi
  done
  printf '%s' "$1"
}

# 已经装了的依赖不再重复安装
missing_list() {
  local list=""
  if (( MISSING_NGINX )); then list="nginx"; fi
  if (( MISSING_CERTBOT )); then list="${list:+$list }certbot"; fi
  printf '%s' "$list"
}

# ---------- 识别发行版 ----------
FAMILY=unknown
ID_LIKE=""
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
case "${ID:-} ${ID_LIKE:-}" in
  *debian*|*ubuntu*|*kali*|*linuxmint*|*raspbian*|*pop*) FAMILY=debian ;;
  *rhel*|*centos*|*fedora*|*rocky*|*almalinux*|*amzn*|*oracle*) FAMILY=rhel ;;
  *suse*) FAMILY=suse ;;
  *arch*|*manjaro*) FAMILY=arch ;;
  *alpine*) FAMILY=alpine ;;
esac

case "$FAMILY" in
  debian) SITES_DIR=/etc/nginx/conf.d; WEBROOT=/var/www/certbot;     NGINX_USER=www-data ;;
  rhel)   SITES_DIR=/etc/nginx/conf.d; WEBROOT=/var/www/certbot;     NGINX_USER=nginx ;;
  suse)   SITES_DIR=/etc/nginx/conf.d; WEBROOT=/srv/www/certbot;     NGINX_USER=nginx ;;
  arch)   SITES_DIR=/etc/nginx/conf.d; WEBROOT=/srv/http/certbot;    NGINX_USER=http ;;
  alpine) SITES_DIR=/etc/nginx/http.d; WEBROOT=/var/lib/nginx/certbot; NGINX_USER=nginx ;;
  *)      SITES_DIR=/etc/nginx/conf.d; WEBROOT=/var/www/certbot;     NGINX_USER=nginx ;;

esac
SITES_DIR="${SITES_DIR_OVERRIDE:-$SITES_DIR}"
WEBROOT="${WEBROOT_OVERRIDE:-$WEBROOT}"

if [[ -d /run/systemd/system ]]; then INIT=systemd
elif command -v rc-service >/dev/null; then INIT=openrc
elif [[ -d /etc/init.d ]]; then INIT=sysv
else INIT=unknown; fi

log "发行版: ${PRETTY_NAME:-unknown} (family=$FAMILY), 初始化系统: $INIT"
log "站点目录: $SITES_DIR    nginx 用户: $NGINX_USER"

version_lt() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

GLIBC_VERSION="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
if [[ -z "$GLIBC_VERSION" ]]; then
  GLIBC_VERSION="$(ldd --version 2>/dev/null | head -1 | awk '{print $NF}')"
fi
if [[ -n "$GLIBC_VERSION" ]] && version_lt "$GLIBC_VERSION" 2.28; then
  warn "glibc $GLIBC_VERSION < 2.28：官方 Node 18+ 二进制无法运行，请用 Node 16 或 glibc-217 非官方构建"
fi

if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
  warn "SELinux 处于 Enforcing，反向代理上游需要放行： setsebool -P httpd_can_network_connect 1"
  warn "若 nginx 读不到 ACME 校验目录： chcon -R -t httpd_sys_content_t $WEBROOT"
fi

# ---------- 依赖 ----------
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "未找到 node，请先安装 Node.js >= ${MIN_NODE_MAJOR}.0.0（见 README「运行环境」）"

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < MIN_NODE_MAJOR )); then
  warn "当前 Node $("$NODE_BIN" -v)，需要 >= ${MIN_NODE_MAJOR}.0.0"
  if [[ "$FAMILY" == "rhel" ]]; then
    warn "CentOS/RHEL 7 的 glibc 是 2.17，官方 Node 18+ 跑不起来，可选："
    warn "  · 官方 Node 16.20.2（最后一代支持 glibc 2.17）"
    warn "    curl -fsSL https://nodejs.org/dist/v16.20.2/node-v16.20.2-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1"
    warn "  · glibc-217 非官方构建 https://unofficial-builds.nodejs.org/download/release/"
    warn "  · 或用 nvm 源码编译：nvm install 16 -s （需要 gcc）"
  fi
  die "Node.js 版本过低，终止安装"
fi
if (( NODE_MAJOR < 18 )); then
  warn "Node ${NODE_MAJOR} 已停止维护（EOL），功能可用但建议尽快升级"
fi

MISSING_NGINX=0
MISSING_CERTBOT=0
have_bin nginx   || MISSING_NGINX=1
have_bin certbot || MISSING_CERTBOT=1
NGINX_BIN="$(bin_path nginx)"
CERTBOT_BIN="$(bin_path certbot)"

if (( MISSING_NGINX == 0 )); then
  NGINX_VER="$("$NGINX_BIN" -v 2>&1 | head -n 1 || true)"
  log "已检测到 nginx（$NGINX_BIN ${NGINX_VER:-版本未知}），跳过安装"
else
  log "未检测到 nginx"
fi
if (( MISSING_CERTBOT == 0 )); then
  CERTBOT_VER="$("$CERTBOT_BIN" --version 2>&1 | head -n 1 || true)"
  log "已检测到 certbot（$CERTBOT_BIN ${CERTBOT_VER:-版本未知}），跳过安装"
else
  log "未检测到 certbot"
fi

if [[ "$SKIP_DEPS" == "1" ]]; then
  log "SKIP_DEPS=1，跳过依赖安装"
elif (( MISSING_NGINX == 0 && MISSING_CERTBOT == 0 )); then
  log "nginx 与 certbot 均已安装，不执行任何包安装命令"
else
  log "需要安装：$(missing_list)（已存在的会自动跳过）"
  case "$FAMILY" in
    debian)
      pkgs=()
      if (( MISSING_NGINX )); then pkgs+=(nginx); fi
      if (( MISSING_CERTBOT )); then pkgs+=(certbot python3-certbot-nginx); fi
      log "apt 安装：${pkgs[*]}"
      apt-get update -qq && apt-get install -y "${pkgs[@]}" ;;

    rhel)
      if command -v dnf >/dev/null; then
        pkgs=()
        if (( MISSING_NGINX )); then pkgs+=(nginx); fi
        if (( MISSING_CERTBOT )); then pkgs+=(certbot python3-certbot-nginx); fi
        log "dnf 安装：${pkgs[*]}"
        dnf install -y "${pkgs[@]}" || warn "certbot 可能需要 EPEL: dnf install -y epel-release"
      else
        if (( MISSING_NGINX )); then
          log "yum 安装：nginx"
          yum install -y nginx || warn "nginx 安装失败，请手动安装"
        fi
        if (( MISSING_CERTBOT )); then
          yum install -y epel-release || true
          log "yum 安装：certbot"
          yum install -y python3-certbot || yum install -y python2-certbot || yum install -y certbot || warn "请手动安装 certbot"
        fi
      fi ;;

    alpine)
      pkgs=()
      if (( MISSING_NGINX )); then pkgs+=(nginx); fi
      if (( MISSING_CERTBOT )); then pkgs+=(certbot); fi
      log "apk 安装：${pkgs[*]}"
      apk add --no-cache "${pkgs[@]}" ;;

    suse)
      pkgs=()
      if (( MISSING_NGINX )); then pkgs+=(nginx); fi
      if (( MISSING_CERTBOT )); then pkgs+=(certbot); fi
      log "zypper 安装：${pkgs[*]}"
      zypper --non-interactive install "${pkgs[@]}" ;;

    arch)
      pkgs=()
      if (( MISSING_NGINX )); then pkgs+=(nginx); fi
      if (( MISSING_CERTBOT )); then pkgs+=(certbot); fi
      log "pacman 安装：${pkgs[*]}"
      pacman -Sy --noconfirm "${pkgs[@]}" ;;

    *) warn "未知发行版，跳过依赖安装；请自行安装缺失的：$(missing_list)" ;;
  esac
fi

have_bin nginx   || warn "未检测到 nginx，反向代理不可用"
have_bin certbot || warn "未检测到 certbot，证书功能不可用，可稍后再装"

# ---------- 部署文件 ----------
install -d "$PREFIX" "$CONF_DIR" "$SITES_DIR" "$WEBROOT" "$PREFIX/data"
cp -r "$ROOT/src" "$ROOT/bin" "$ROOT/package.json" "$PREFIX/"

if [[ ! -f "$CONF_DIR/config.json" ]]; then
  cat > "$CONF_DIR/config.json" <<JSON
{
  "panel": { "host": "127.0.0.1", "port": 8787, "authToken": "" },
  "nginx": {
    "bin": "nginx",
    "mainConf": "/etc/nginx/nginx.conf",
    "sitesDir": "$SITES_DIR",
    "filePrefix": "fanproxy-",
    "logDir": "/var/log/nginx",
    "logFormat": "combined",
    "user": "$NGINX_USER"
  },
  "certbot": {
    "bin": "certbot",
    "email": "",
    "webroot": "$WEBROOT",
    "liveDir": "/etc/letsencrypt/live",
    "staging": false,
    "renewBeforeDays": 30,
    "extraArgs": []
  },
  "scheduler": { "enabled": true, "intervalMinutes": 720 },
  "backup": { "enabled": true, "dir": "", "keep": 50 },
  "dataDir": "$PREFIX/data",
  "logLevel": "info"
}
JSON
  log "已生成配置 $CONF_DIR/config.json，记得修改 panel.authToken 或设置管理员密码"
else
  log "配置已存在，保留 $CONF_DIR/config.json"
fi

# ---------- 注册服务 ----------
case "$INIT" in
  systemd)
    sed "s|^ExecStart=.*|ExecStart=$NODE_BIN $PREFIX/bin/fanproxy.js|" "$ROOT/deploy/fanproxy.service" > /etc/systemd/system/fanproxy.service
    systemctl daemon-reload
    log "已安装 systemd 服务：systemctl enable --now fanproxy"
    ;;
  openrc)
    sed "s|^command=.*|command=\"$NODE_BIN\"|" "$ROOT/deploy/fanproxy.openrc" > /etc/init.d/fanproxy
    chmod +x /etc/init.d/fanproxy
    rc-update add fanproxy default >/dev/null 2>&1 || true
    log "已安装 OpenRC 服务：rc-service fanproxy start"
    ;;
  sysv)
    warn "未识别的服务管理器，请手动以 root 运行：FAN_CONFIG=$CONF_DIR/config.json $NODE_BIN $PREFIX/bin/fanproxy.js"
    ;;
esac

# ---------- include 检查 ----------
if [[ -f /etc/nginx/nginx.conf ]] && ! grep -q -- "$SITES_DIR" /etc/nginx/nginx.conf; then
  warn "nginx 主配置未引入 $SITES_DIR，请在 http {} 中加入： include $SITES_DIR/*.conf;"
  warn "也可以在面板「设置 → nginx 接入」里一键写入（自动备份 + 校验）"
else
  log "nginx 已加载 $SITES_DIR，每个代理会以独立 conf 文件写入"
fi

log "安装完成"
log "卸载：sudo bash deploy/uninstall.sh（会询问是否一并删除 nginx / certbot）"
