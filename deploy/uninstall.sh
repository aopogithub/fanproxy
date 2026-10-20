#!/usr/bin/env bash
# fanproxy 卸载脚本：停服务 + 删程序目录，并按需卸载 nginx / certbot。
#
# 用法：
#   sudo bash deploy/uninstall.sh        # 交互式：逐项询问
#   sudo bash deploy/uninstall.sh -y     # 不询问：只卸 fanproxy，保留 nginx / certbot / 配置
#   REMOVE_NGINX=1 REMOVE_CERTBOT=1 REMOVE_CONFIG=1 sudo bash deploy/uninstall.sh -y
set -euo pipefail

PREFIX="${PREFIX:-/opt/fanproxy}"
CONF_DIR="${CONF_DIR:-/etc/fanproxy}"
LOG_DIR="${LOG_DIR:-/var/log/nginx/fanproxy}"
LEGACY_PREFIX="${LEGACY_PREFIX:-/opt/fan}"       # 改名前的目录，检测到会询问是否一并删除
LEGACY_CONF="${LEGACY_CONF:-/etc/fan}"
LEGACY_LOG_DIR="${LEGACY_LOG_DIR:-/var/log/nginx/fan}"
LEGACY_SERVICE="${LEGACY_SERVICE:-fan}"
SERVICE="fanproxy"

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) printf '[fanproxy] 未知参数: %s（只支持 -y / --yes / --help）\n' "$arg" >&2; exit 2 ;;
  esac
done

log()  { printf '[fanproxy] %s\n' "$*"; }
warn() { printf '[fanproxy] 警告: %s\n' "$*" >&2; }

# ---------- 探测 ----------
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

BIN_DIRS=(/usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin)
have_bin() {
  command -v "$1" >/dev/null 2>&1 && return 0
  local dir
  for dir in "${BIN_DIRS[@]}"; do
    [[ -x "$dir/$1" ]] && return 0
  done
  return 1
}

# 询问是否执行某项，$2 是默认答案（y/n）；-y 或非交互时直接采用默认值
ask() {
  local question="$1" default="${2:-n}" answer
  if (( ASSUME_YES )); then
    printf '[fanproxy] %s → %s（-y 模式）\n' "$question" "$([[ "$default" == y ]] && echo 是 || echo 否)"
    [[ "$default" == y ]]
    return
  fi
  if [[ ! -t 0 ]]; then
    printf '[fanproxy] %s → %s（无交互终端）\n' "$question" "$([[ "$default" == y ]] && echo 是 || echo 否)"
    [[ "$default" == y ]]
    return
  fi
  read -r -p "[fanproxy] $question [$([[ "$default" == y ]] && echo 'Y/n' || echo 'y/N')] " answer || answer=""
  answer="${answer:-$default}"
  answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
  [[ "$answer" == y || "$answer" == yes ]]
}

# 环境变量优先于交互询问
decide() {  # decide <env值> <默认答案>
  local value="${1:-}" default="$2"
  case "$value" in
    1|y|Y|yes|YES|true) return 0 ;;
    0|n|N|no|NO|false) return 1 ;;
  esac
  ask "$3" "$default"
}

log "发行版: ${PRETTY_NAME:-unknown} (family=$FAMILY)"
log "程序目录: $PREFIX    配置目录: $CONF_DIR"

# ---------- 1. 停服务 + 删服务单元 ----------
if ! ask "确认卸载 fanproxy（停止服务并删除 $PREFIX）？" y; then
  log "已取消，未做任何改动"
  exit 0
fi

stop_service() {
  local name="$1"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "$name.service" >/dev/null 2>&1 || true
  elif command -v rc-service >/dev/null 2>&1; then
    rc-service "$name" stop >/dev/null 2>&1 || true
  elif [[ -x "/etc/init.d/$name" ]]; then
    "/etc/init.d/$name" stop >/dev/null 2>&1 || true
  fi
}

for name in "$SERVICE" "$LEGACY_SERVICE"; do
  stop_service "$name"
done

if command -v systemctl >/dev/null 2>&1; then
  for name in "$SERVICE" "$LEGACY_SERVICE"; do
    if [[ -f "/etc/systemd/system/$name.service" ]]; then
      rm -f "/etc/systemd/system/$name.service"
      log "已删除服务单元 /etc/systemd/system/$name.service"
    fi
  done
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
if command -v rc-update >/dev/null 2>&1; then
  for name in "$SERVICE" "$LEGACY_SERVICE"; do
    rc-update del "$name" default >/dev/null 2>&1 || true
    rm -f "/etc/init.d/$name"
  done
fi

if [[ -d "$PREFIX" ]]; then
  rm -rf "$PREFIX"
  log "已删除程序目录 $PREFIX"
else
  log "程序目录 $PREFIX 不存在，跳过"
fi

# ---------- 2. 配置 / 数据 / 日志 ----------
if decide "${REMOVE_CONFIG:-}" n "是否删除配置与站点数据（$CONF_DIR、$LOG_DIR）？"; then
  rm -rf "$CONF_DIR" "$LOG_DIR"
  log "已删除 $CONF_DIR 与站点日志目录 $LOG_DIR"
else
  log "保留配置与数据：$CONF_DIR"
fi

if [[ -d "$LEGACY_PREFIX" || -d "$LEGACY_CONF" || -d "$LEGACY_LOG_DIR" ]]; then
  if decide "${REMOVE_LEGACY:-}" n "检测到改名前的旧目录（$LEGACY_PREFIX、$LEGACY_CONF、$LEGACY_LOG_DIR），是否一并删除？"; then
    rm -rf "$LEGACY_PREFIX" "$LEGACY_CONF" "$LEGACY_LOG_DIR"
    log "已删除旧版本目录"
  else
    log "保留旧版本目录（迁移配置可用：cp -r $LEGACY_CONF $CONF_DIR）"
  fi
fi

# ---------- 3. 卸载 nginx ----------
if have_bin nginx; then
  if decide "${REMOVE_NGINX:-}" n "是否卸载 nginx？（会停止 nginx 服务，/etc/nginx 配置目录保留）"; then
    log "停止 nginx 服务"
    stop_service nginx
    case "$FAMILY" in
      debian) apt-get remove -y nginx nginx-common || apt-get remove -y nginx || warn "nginx 卸载失败，请手动处理" ;;
      rhel)
        if command -v dnf >/dev/null 2>&1; then dnf remove -y nginx || warn "nginx 卸载失败"
        else yum remove -y nginx || warn "nginx 卸载失败"; fi ;;
      alpine) apk del nginx || warn "nginx 卸载失败" ;;
      suse)   zypper --non-interactive remove nginx || warn "nginx 卸载失败" ;;
      arch)   pacman -R --noconfirm nginx || warn "nginx 卸载失败" ;;
      *)      warn "未知发行版：请手动卸载 nginx" ;;
    esac
    if have_bin nginx; then
      warn "nginx 仍然存在，请手动确认"
    else
      log "nginx 已卸载（/etc/nginx 里的配置与站点目录保留）"
    fi
  else
    log "保留 nginx"
  fi
else
  log "未检测到 nginx，跳过"
fi

# ---------- 4. 卸载 certbot ----------
if have_bin certbot; then
  if decide "${REMOVE_CERTBOT:-}" n "是否卸载 certbot？（已签发的证书目录 /etc/letsencrypt 会保留）"; then
    case "$FAMILY" in
      debian) apt-get remove -y certbot python3-certbot-nginx python3-certbot || warn "certbot 卸载失败，请手动处理" ;;
      rhel)
        if command -v dnf >/dev/null 2>&1; then dnf remove -y certbot python3-certbot-nginx || warn "certbot 卸载失败"
        else yum remove -y certbot python3-certbot-nginx || warn "certbot 卸载失败"; fi ;;
      alpine) apk del certbot || warn "certbot 卸载失败" ;;
      suse)   zypper --non-interactive remove certbot || warn "certbot 卸载失败" ;;
      arch)   pacman -R --noconfirm certbot || warn "certbot 卸载失败" ;;
      *)      warn "未知发行版：请手动卸载 certbot" ;;
    esac
    if have_bin certbot; then
      warn "certbot 仍然存在（可能是 pip / snap 安装），请手动确认： pip uninstall certbot / snap remove certbot"
    else
      log "certbot 已卸载（/etc/letsencrypt 里的证书保留）"
    fi
  else
    log "保留 certbot"
  fi
else
  log "未检测到 certbot，跳过"
fi

# ---------- 收尾提示 ----------
log "卸载完成"
if [[ -f /etc/nginx/nginx.conf ]] && grep -q 'fanproxy' /etc/nginx/nginx.conf 2>/dev/null; then
  warn "nginx 主配置里还留着 fanproxy 写入的 include 行，如不再使用请手动删除"
fi
if [[ -d /etc/letsencrypt/live ]]; then
  log "证书仍在 /etc/letsencrypt/live，确认不再需要后可自行删除"
fi
