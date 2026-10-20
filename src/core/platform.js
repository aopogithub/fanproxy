'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 跨发行版适配层：识别操作系统家族，并给出 nginx / certbot / 服务管理器的合理默认值。
 * 所有探测都是只读且带兜底，任何一步失败都不会抛异常。
 */

const FAMILY_DEFAULTS = {
  debian: {
    label: 'Debian/Ubuntu',
    mainConf: ['/etc/nginx/nginx.conf'],
    sitesDir: ['/etc/nginx/conf.d'],
    logDir: '/var/log/nginx',
    webroot: '/var/www/certbot',
    nginxUser: 'www-data',
    packages: { nginx: 'nginx', certbot: 'certbot python3-certbot-nginx' },
  },
  rhel: {
    label: 'RHEL/CentOS/Fedora',
    mainConf: ['/etc/nginx/nginx.conf'],
    sitesDir: ['/etc/nginx/conf.d'],
    logDir: '/var/log/nginx',
    webroot: '/var/www/certbot',
    nginxUser: 'nginx',
    packages: { nginx: 'nginx', certbot: 'certbot python3-certbot-nginx（需 EPEL）' },
  },
  suse: {
    label: 'openSUSE/SLES',
    mainConf: ['/etc/nginx/nginx.conf'],
    sitesDir: ['/etc/nginx/conf.d'],
    logDir: '/var/log/nginx',
    webroot: '/srv/www/certbot',
    nginxUser: 'nginx',
    packages: { nginx: 'nginx', certbot: 'certbot' },
  },
  arch: {
    label: 'Arch/Manjaro',
    mainConf: ['/etc/nginx/nginx.conf'],
    sitesDir: ['/etc/nginx/conf.d'],
    logDir: '/var/log/nginx',
    webroot: '/srv/http/certbot',
    nginxUser: 'http',
    packages: { nginx: 'nginx', certbot: 'certbot' },
  },
  alpine: {
    label: 'Alpine Linux',
    mainConf: ['/etc/nginx/nginx.conf'],
    sitesDir: ['/etc/nginx/http.d'],
    logDir: '/var/log/nginx',
    webroot: '/var/lib/nginx/certbot',
    nginxUser: 'nginx',
    packages: { nginx: 'nginx', certbot: 'certbot' },
  },
  freebsd: {
    label: 'FreeBSD',
    mainConf: ['/usr/local/etc/nginx/nginx.conf'],
    sitesDir: ['/usr/local/etc/nginx/conf.d'],
    logDir: '/var/log/nginx',
    webroot: '/usr/local/www/certbot',
    nginxUser: 'www',
    packages: { nginx: 'nginx', certbot: 'py311-certbot' },
  },
  darwin: {
    label: 'macOS',
    mainConf: ['/opt/homebrew/etc/nginx/nginx.conf', '/usr/local/etc/nginx/nginx.conf'],
    sitesDir: ['/opt/homebrew/etc/nginx/servers', '/usr/local/etc/nginx/servers', '/opt/homebrew/etc/nginx/conf.d', '/usr/local/etc/nginx/conf.d'],
    logDir: '/opt/homebrew/var/log/nginx',
    webroot: '/opt/homebrew/var/www/certbot',
    nginxUser: '',
    packages: { nginx: 'nginx', certbot: 'certbot' },
  },
  unknown: {
    label: '未知系统',
    mainConf: ['/etc/nginx/nginx.conf', '/usr/local/etc/nginx/nginx.conf'],
    sitesDir: ['/etc/nginx/conf.d', '/etc/nginx/http.d', '/usr/local/etc/nginx/conf.d'],
    logDir: '/var/log/nginx',
    webroot: '/var/www/certbot',
    nginxUser: 'nginx',
    packages: { nginx: 'nginx', certbot: 'certbot' },
  },
};

const ID_FAMILY = [
  [/^(debian|ubuntu|linuxmint|kali|raspbian|pop|elementary|deepin|zorin|devuan|mx)$/, 'debian'],
  [/^(rhel|centos|fedora|rocky|almalinux|alma|ol|oracle|amzn|scientific|cloudlinux)$/, 'rhel'],
  [/^(opensuse.*|sles|sled|suse)$/, 'suse'],
  [/^(arch|manjaro|endeavouros|garuda|artix|cachyos)$/, 'arch'],
  [/^(alpine|postmarketos)$/, 'alpine'],
];

function detect(env = process.env) {
  const release = readOsRelease();
  const ids = [release.ID, ...String(release.ID_LIKE || '').split(/\s+/)].filter(Boolean).map((id) => id.toLowerCase());

  let family = 'unknown';
  if (process.platform === 'darwin') family = 'darwin';
  else if (process.platform === 'freebsd') family = 'freebsd';
  else {
    for (const id of ids) {
      const hit = ID_FAMILY.find(([re]) => re.test(id));
      if (hit) {
        family = hit[1];
        break;
      }
    }
    if (family === 'unknown' && fs.existsSync('/etc/alpine-release')) family = 'alpine';
  }

  const preset = FAMILY_DEFAULTS[family] || FAMILY_DEFAULTS.unknown;
  const init = detectInitSystem();

  return {
    family,
    label: preset.label,
    name: release.PRETTY_NAME || release.NAME || os.type(),
    version: release.VERSION_ID || release.VERSION || '',
    arch: os.arch(),
    platform: process.platform,
    kernel: os.release(),
    init,
    packageManager: detectPackageManager(),
    nginxUser: preset.nginxUser,
    packages: preset.packages,
    defaults: {
      mainConf: preset.mainConf,
      sitesDir: preset.sitesDir,
      logDir: preset.logDir,
      webroot: preset.webroot,
      certbotLiveDir: '/etc/letsencrypt/live',
    },
    reloadFallbacks: reloadFallbacks(init),
  };
}

function readOsRelease() {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const read = (key) => {
        const match = new RegExp(`^${key}=(.*)$`, 'm').exec(content);
        if (!match) return '';
        return match[1].trim().replace(/^["']|["']$/g, '');
      };
      return { ID: read('ID'), ID_LIKE: read('ID_LIKE'), NAME: read('NAME'), PRETTY_NAME: read('PRETTY_NAME'), VERSION: read('VERSION'), VERSION_ID: read('VERSION_ID') };
    } catch {
      continue;
    }
  }
  return {};
}

function detectInitSystem() {
  if (process.platform === 'darwin') return 'launchd';
  try {
    if (fs.existsSync('/run/systemd/system')) return 'systemd';
  } catch { /* ignore */ }
  if (which('rc-service')) return 'openrc';
  if (which('systemctl')) return 'systemd';
  try {
    if (fs.existsSync('/etc/init.d')) return 'sysv';
  } catch { /* ignore */ }
  return 'unknown';
}

function detectPackageManager() {
  const candidates = [
    ['apt-get', 'apt'],
    ['dnf', 'dnf'],
    ['yum', 'yum'],
    ['zypper', 'zypper'],
    ['apk', 'apk'],
    ['pacman', 'pacman'],
    ['pkg', 'pkg'],
    ['brew', 'brew'],
  ];
  for (const [bin, name] of candidates) if (which(bin)) return name;
  return 'unknown';
}

function reloadFallbacks(init) {
  switch (init) {
    case 'systemd':
      return [['systemctl', ['reload', 'nginx']], ['systemctl', ['restart', 'nginx']]];
    case 'openrc':
      return [['rc-service', ['nginx', 'reload']], ['rc-service', ['nginx', 'restart']]];
    case 'sysv':
      return [['service', ['nginx', 'reload']]];
    default:
      return [];
  }
}

function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return path.join(dir, bin);
    } catch { /* keep looking */ }
  }
  return null;
}

/** 在候选路径里挑第一个真实存在的，都没有就返回第一个候选。 */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return candidates[0];
}

/** 安装依赖的命令提示，安装脚本和启动日志共用。 */
function installHint(platform) {
  const packages = platform.packages || {};
  switch (platform.packageManager) {
    case 'apt':
      return `apt-get update && apt-get install -y ${packages.nginx || 'nginx'} ${packages.certbot || 'certbot'}`;
    case 'dnf':
      return `dnf install -y ${packages.nginx || 'nginx'} ${packages.certbot || 'certbot'}`;
    case 'yum':
      return `yum install -y epel-release && yum install -y ${packages.nginx || 'nginx'} ${packages.certbot || 'certbot'}`;
    case 'zypper':
      return `zypper install -y ${packages.nginx || 'nginx'} ${packages.certbot || 'certbot'}`;
    case 'apk':
      return `apk add --no-cache ${packages.nginx || 'nginx'} ${packages.certbot || 'certbot'}`;
    case 'pacman':
      return `pacman -S --noconfirm ${packages.nginx || 'nginx'} ${packages.certbot || 'certbot'}`;
    case 'pkg':
      return `pkg install -y ${packages.nginx || 'nginx'} ${packages.certbot || 'certbot'}`;
    case 'brew':
      return `brew install ${packages.nginx || 'nginx'} ${packages.certbot || 'certbot'}`;
    default:
      return '请手动安装 nginx 与 certbot';
  }
}

/**
 * 查系统用户（只读 /etc/passwd，避免依赖外部命令）。返回 { uid, gid } 或 null。
 */
function lookupUser(name) {
  if (!name || process.platform === 'win32') return null;
  try {
    const content = fs.readFileSync('/etc/passwd', 'utf8');
    for (const line of content.split('\n')) {
      const parts = line.split(':');
      if (parts[0] !== name) continue;
      const uid = Number(parts[2]);
      const gid = Number(parts[3]);
      if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = { detect, firstExisting, installHint, lookupUser, FAMILY_DEFAULTS };
