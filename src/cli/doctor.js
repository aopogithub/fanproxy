'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns').promises;

const { run, resolveBinary } = require('../core/exec');
const { installHint } = require('../core/platform');
const { Nginx } = require('../core/nginx');
const { Certbot } = require('../core/certbot');
const { Store } = require('../store');
const configModule = require('../config');

const MARK = { ok: '✓', bad: '✗', warn: '!' };
const CERTBOT_LOG = '/var/log/letsencrypt/letsencrypt.log';

function createReport() {
  const items = [];
  const push = (level) => (label, detail = '', hint = '') => items.push({ level, label, detail, hint });
  return { items, ok: push('ok'), bad: push('bad'), warn: push('warn') };
}

const tail = (text, lines = 2) => String(text || '').trim().split('\n').slice(-lines).join(' | ');

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一键自检：把「申请不到证书」时最常踩的坑按顺序查一遍。
 * 只读为主，唯一的写操作是在 webroot 下放一个临时探测文件用于端到端校验。
 */
async function doctor(config, report = createReport()) {
  const platform = config.platform || {};
  const nginx = new Nginx(config);
  const certbot = new Certbot(config);
  const store = new Store(config);

  // ---------- 运行环境 ----------
  report.ok('Node', process.version);
  report.ok('系统', `${platform.label || '未知'} · ${platform.name || ''} · init=${platform.init} · pkg=${platform.packageManager}`);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    report.warn('运行身份', `uid=${process.getuid()}（非 root）`, '面板要写 nginx 配置目录和证书目录，建议用 root 运行');
  }

  // ---------- nginx ----------
  if (!nginx.installed) {
    report.bad('nginx', `未找到 ${config.nginx.bin}`, `安装：${installHint(platform)}`);
  } else {
    report.ok('nginx', await nginx.version());
    if (!config.nginx.mainConf || !fs.existsSync(config.nginx.mainConf)) {
      report.bad('nginx 主配置', config.nginx.mainConf || '(未配置)', '检查 config.json 的 nginx.mainConf，或在「设置」里按平台提示修正');
    } else {
      report.ok('nginx 主配置', config.nginx.mainConf);
    }
    const include = nginx.checkInclude();
    if (include.ok) report.ok('站点目录 include', include.snippet);
    else report.warn('站点目录 include', include.reason || '未加载', '点面板「概览 → 写入 include」按钮，或手动把 include 加到 http{} 里');

    const test = await nginx.test();
    if (test.ok) report.ok('nginx -t', '配置语法通过');
    else report.bad('nginx -t', tail(test.stderr || test.stdout), '先修好 nginx 自身配置，面板才不会回滚');
  }

  for (const [name, dir] of [['站点目录', config.nginx.sitesDir], ['日志目录', config.nginx.logDir]]) {
    if (!dir) report.warn(name, '未配置');
    else if (!fs.existsSync(dir)) report.bad(name, `${dir} 不存在`, '确认 nginx 已安装并启动过；面板启动时也会自动创建');
    else if (!writable(dir)) report.bad(name, `${dir} 不可写`, '面板需要 root（或对该目录有写权限）');
    else report.ok(name, dir);
  }

  // ---------- certbot ----------
  if (!certbot.installed) {
    report.bad('certbot', `未找到 ${config.certbot.bin}`, `安装：${installHint(platform)}`);
  } else {
    report.ok('certbot', await certbot.version());
    if (config.certbot.liveDir && !fs.existsSync(config.certbot.liveDir)) {
      report.warn('证书目录', `${config.certbot.liveDir} 不存在`, '说明还没成功签发过证书，属正常现象');
    } else {
      report.ok('证书目录', config.certbot.liveDir);
    }
  }

  const webroot = config.certbot.webroot;
  if (!webroot) {
    report.bad('webroot', '未配置', 'config.json 里设置 certbot.webroot');
  } else {
    try {
      fs.mkdirSync(webroot, { recursive: true });
      report.ok('webroot', `${webroot}${writable(webroot) ? '' : '（不可写）'}`);
      if (!writable(webroot)) report.bad('webroot 可写', webroot, 'certbot 校验时需要往这里写文件，检查权限/属主');
    } catch (err) {
      report.bad('webroot', `${webroot}: ${err.message}`, '检查目录权限，或改 config.json 的 certbot.webroot');
    }
  }

  // ---------- 站点与 ACME 链路 ----------
  const sites = store.list().filter((site) => site.enabled);
  if (!sites.length) report.warn('站点', '没有启用的站点', '先在面板里创建站点');
  for (const site of sites) {
    const primary = site.serverNames.find((name) => !name.startsWith('*'));
    const label = `站点 ${site.name}`;
    if (!primary) {
      report.bad(label, `只有泛域名：${site.serverNames.join(', ')}`, 'webroot 方式不支持泛域名，至少加一个普通域名');
      continue;
    }
    if (!fs.existsSync(path.join(config.nginx.sitesDir, site.confFile))) {
      report.warn(label, `配置文件 ${site.confFile} 不在磁盘上`, '在面板里保存/应用一次该站点');
    }
    const requested = site.listenHttp;
    if (requested !== 80) {
      report.bad(`${label} 端口`, `HTTP 监听 ${requested}`, 'ACME HTTP-01 校验固定访问 80 端口，把 listenHttp 改回 80');
    }
    await probeDomain(primary, webroot, report);
  }

  // ---------- SELinux ----------
  if (resolveBinary('getenforce')) {
    const mode = (await run('getenforce')).stdout.trim();
    if (mode === 'Enforcing') {
      report.warn('SELinux', 'Enforcing', '被拦时看 ausearch -m avc -ts recent；反代上游需要 setsebool -P httpd_can_network_connect 1');
      const ports = resolveBinary('semanage') ? (await run('semanage', ['port', '-l'])).stdout : '';
      if (ports && !/http_port_t.*\b80\b/.test(ports)) {
        report.warn('SELinux 端口', 'http_port_t 未包含 80', 'semanage port -a -t http_port_t -p tcp 80');
      }
    } else {
      report.ok('SELinux', mode || '未启用');
    }
  }

  // ---------- 防火墙 ----------
  const firewalld = resolveBinary('firewall-cmd');
  if (firewalld) {
    const state = await run(firewalld, ['--state']);
    if (state.ok && state.stdout.includes('running')) {
      const all = await run(firewalld, ['--list-all']);
      const text = all.stdout;
      const open80 = /\bhttp\b/.test(text) || /\bports:.*\b80\/tcp\b/.test(text);
      if (open80) report.ok('firewalld', '80 端口已放行');
      else report.bad('firewalld', tail(text, 3), 'firewall-cmd --add-service=http --permanent && firewall-cmd --reload');
    } else {
      report.ok('firewalld', '未运行');
    }
  } else if (resolveBinary('ufw')) {
    const status = await run('ufw', ['status']);
    if (/\b80\b/.test(status.stdout)) report.ok('ufw', '80 端口已放行');
    else report.warn('ufw', tail(status.stdout, 2), 'ufw allow 80/tcp（别忘了 443）');
  }

  // ---------- certbot 日志线索 ----------
  if (fs.existsSync(CERTBOT_LOG)) {
    const lines = fs.readFileSync(CERTBOT_LOG, 'utf8').split('\n').slice(-400);
    const args = lines.filter((line) => line.includes('Arguments:')).slice(-1)[0];
    const version = lines.filter((line) => line.includes('certbot version:')).slice(-1)[0];
    if (version) report.ok('certbot 日志', `${version.split('certbot version:')[1].trim()}（${CERTBOT_LOG}）`);
    if (!args) report.warn('certbot 调用记录', '日志里没有 Arguments 行');
    else if (/Arguments: \[\]/.test(args)) report.bad('certbot 调用记录', args.trim(), '最后一条是空参数的 certbot（手动执行），说明面板的签发请求还没走到 certbot，看面板日志 执行 certbot: 那行');
    else report.ok('certbot 调用记录', args.split('Arguments:')[1].trim());
  } else {
    report.warn('certbot 日志', `${CERTBOT_LOG} 不存在`, 'certbot 还没运行过');
  }

  return report;
}

// 查询用到的解析器：系统解析器 + 两个公共解析器，用来对比「本机能不能解析」和「公网能不能解析」
const RESOLVERS = [
  { label: '系统解析器', server: null },
  { label: '8.8.8.8', server: '8.8.8.8' },
  { label: '1.1.1.1', server: '1.1.1.1' },
];
const DNS_TIMEOUT = 5000;

/** 本机网卡地址；某些受限环境（容器/沙箱）拿不到，取不到时返回空数组而不是抛错。 */
function localAddresses() {
  try {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((info) => info && !info.internal)
      .map((info) => info.address);
  } catch {
    return [];
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} 超时`), { code: 'ETIMEOUT' })), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function dnsCode(err) {
  if (err.code === 'ENOTFOUND') return 'NXDOMAIN';
  if (err.code === 'ENODATA') return 'NODATA';
  if (err.code === 'ETIMEOUT') return '超时';
  return err.code || err.message;
}

/**
 * 同时查 A / AAAA：certbot 报的 "NXDOMAIN looking up AAAA" 就是这里能复现的。
 * 只解析 A 但权威服务器对 AAAA 回 NXDOMAIN 时，Let's Encrypt 会认为域名不存在而拒绝签发。
 */
async function checkDns(domain, report) {
  const label = `DNS ${domain}`;
  const summary = [];
  let aResolved = null;
  let aaaaNxdomain = null;
  let answered = false;

  for (const { label: who, server } of RESOLVERS) {
    const resolver = new dns.Resolver();
    if (server) resolver.setServers([server]);
    const row = { who, A: null, AAAA: null };
    for (const type of ['A', 'AAAA']) {
      const method = type === 'A' ? 'resolve4' : 'resolve6';
      try {
        row[type] = (await withTimeout(resolver[method](domain), DNS_TIMEOUT, `${who} ${type}`)).join(', ');
      } catch (err) {
        row[type] = dnsCode(err);
      }
    }
    if (server === null) aResolved = /^\d/.test(row.A || '') ? row.A : null;
    if (/^\d/.test(row.A || '') || /^[0-9a-f:]+$/i.test(row.AAAA || '')) answered = true;
    if (row.A === 'NXDOMAIN' || row.A === 'NODATA' || row.AAAA === 'NXDOMAIN' || row.AAAA === 'NODATA') answered = true;
    if (row.AAAA === 'NXDOMAIN' && aaaaNxdomain === null) aaaaNxdomain = who;
    summary.push(`${who}: A=${row.A} AAAA=${row.AAAA}`);
  }

  const local = localAddresses();
  const detail = summary.join('；');

  if (!answered) {
    report.warn(label, `${detail}`, '本机 DNS 查询不通（解析器不可用或被限制），无法判断域名解析；先用 dig/nslookup 手动确认，再重跑自检');
    return false;
  }
  if (!aResolved) {
    report.bad(label, detail, /NXDOMAIN/.test(detail)
      ? '权威 DNS 返回 NXDOMAIN：这个子域不存在。去域名商加一条指向本机公网 IP 的 A 记录（刚加的解析注意等过负缓存 TTL）'
      : '域名没有可用的 A 记录：先去域名商给这个子域添加指向本机公网 IP 的 A 记录');
    return false;
  }
  if (aaaaNxdomain) {
    report.warn(label, `${detail}`,
      '权威 DNS 对 AAAA 查询返回 NXDOMAIN（而不是「无此类型记录」），Let\'s Encrypt 会据此判定域名不存在并拒绝签发：'
      + '给这个子域补一条 AAAA 记录（服务器有 IPv6 时指向它），或把解析换到会返回 NOERROR/NODATA 的服务商（Cloudflare 等）');
  } else if (local.includes(aResolved.split(', ')[0])) {
    report.ok(label, detail);
  } else {
    report.warn(label, detail, `解析到 ${aResolved}，本机网卡是 ${local.join(', ') || '无'}：确认 A 记录指向这台机器的公网 IP，NAT 环境要把 80 端口转发过来`);
  }
  return true;
}

/** 在 webroot 放一个探测文件，再从域名的 80 端口取回来：一次把 DNS / 防火墙 / nginx 全验了。 */
async function probeDomain(domain, webroot, report) {
  const label = `ACME 探测 ${domain}`;
  if (!(await checkDns(domain, report))) return;

  const curl = resolveBinary('curl');
  if (!curl) {
    report.warn(label, '未找到 curl，跳过', '手动验证：curl -I http://' + domain + '/.well-known/acme-challenge/');
    return;
  }

  const token = `fanproxy-probe-${Date.now().toString(36)}`;
  const dir = path.join(webroot, '.well-known', 'acme-challenge');
  const file = path.join(dir, token);
  const url = `http://${domain}/.well-known/acme-challenge/${token}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, token);
  } catch (err) {
    report.bad(label, `无法写入 ${dir}: ${err.message}`, '检查 webroot 权限');
    return;
  }
  try {
    const res = await run(curl, ['-sS', '-m', '20', '-o', '-', '-w', '\n%{http_code}', url]);
    const split = res.stdout.lastIndexOf('\n');
    const body = split === -1 ? res.stdout : res.stdout.slice(0, split);
    const status = split === -1 ? '' : res.stdout.slice(split + 1).trim();
    if (res.ok && body.trim() === token) report.ok(label, `HTTP ${status} 校验文件可访问`);
    else if (res.ok && ['301', '302', '308'].includes(status)) {
      report.bad(label, `HTTP ${status} 被跳转到 HTTPS`, 'ACME 校验走 HTTP，确认 80 端口的 location /.well-known/acme-challenge/ 没有被整体跳转覆盖');
    } else {
      report.bad(label, `HTTP ${status || '无响应'} ${tail(res.stderr || body, 1)}`,
        '按顺序查：域名解析 → 运营商/云厂商安全组 → 本机防火墙 → nginx 是否在跑 → 面板里这个站点是否已保存生效');
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function printReport(report) {
  const lines = ['', 'fanproxy 自检', '--------'];
  for (const item of report.items) {
    const detail = item.detail ? ` ${item.detail}` : '';
    lines.push(`${MARK[item.level] || '-'} ${item.label}${detail}`);
    if (item.hint) lines.push(`    ↳ ${item.hint}`);
  }
  const bad = report.items.filter((item) => item.level === 'bad');
  const warn = report.items.filter((item) => item.level === 'warn');
  lines.push('');
  lines.push(bad.length
    ? `发现 ${bad.length} 个阻塞问题、${warn.length} 个提醒：按上面的 ↳ 逐条处理后重跑 fanproxy doctor`
    : `没有阻塞问题（${warn.length} 个提醒）`);
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
  return bad.length;
}

async function runDoctor() {
  const config = configModule.load();
  const report = await doctor(config);
  return printReport(report);
}

module.exports = { doctor, runDoctor, createReport, probeDomain };

if (require.main === module) {
  runDoctor().then((bad) => { process.exitCode = bad ? 1 : 0; }).catch((err) => {
    process.stderr.write(`[fanproxy] 自检失败: ${err.message}\n`);
    process.exitCode = 1;
  });
}
