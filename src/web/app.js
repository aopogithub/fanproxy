'use strict';

const state = {
  token: localStorage.getItem('fanproxy.token') || '',
  me: null,
  status: null,
  sites: [],
  current: null,
  certs: [],
  backups: [],
  users: [],
  tops: {},
  topsExpanded: {},
  health: null,
  streams: [],
  streamInfo: null,
  currentStream: null,
};

/** Top URL / IP / UA 默认只展示前几条，点「更多」展开全部（后端默认返回 10 条） */
const TOP_PREVIEW = 3;
const LOGS_TOP_LIMIT = 20;

/** 站点列表里的健康探测竖条数量（与后端保留的历史条数一致）。 */
const HEALTH_BARS = 20;

/** 竖条区域自动刷新：只替换 .health-bars，不动表单与其它 DOM。 */
const HEALTH_AUTO_KEY = 'fanproxy.healthAuto';
const HEALTH_REFRESH_MS = 10000;
let healthTimer = null;
let healthRefreshing = false;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/* ---------- 基础工具 ---------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { 'x-fanproxy-token': state.token } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (res.status === 401) showLogin(data.error);
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

function log(message, kind = '') {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  const el = $('#log');
  el.innerHTML += `<span class="${kind}">${esc(line)}</span>\n`;
  el.scrollTop = el.scrollHeight;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(value) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.data && err.data.requiresLogin) return undefined;
    log(err.message, 'bad');
    setFormStatus(err.message, 'bad');
    for (const step of err.data?.steps || []) {
      if (step.detail) log(`  · ${step.step}: ${lastLines(step.detail, 3)}`, step.ok ? '' : 'bad');
    }
    return undefined;
  }
}

/** create：表单在新建站点；edit：表单在编辑某个站点。 */
let formMode = 'create';

function openSiteModal() {
  $('#siteOverlay').hidden = false;
}

function closeSiteModal() {
  $('#siteOverlay').hidden = true;
}

function setFormStatus(message, kind = '') {
  const el = $('#formStatus');
  if (!el) return;
  el.hidden = !message;
  el.className = `body-sm ${kind ? kind : 'body-light'}`;
  el.textContent = message || '';
}

/** 耗时操作（签发证书 / apply）期间禁用按钮，避免重复点击，并让用户知道正在进行。 */
async function withBusy(button, label, fn) {
  if (!button) return fn();
  const original = button.textContent;
  button.disabled = true;
  button.dataset.busy = '1';
  button.textContent = label;
  setFormStatus(label);
  try {
    return await fn();
  } finally {
    button.disabled = false;
    delete button.dataset.busy;
    button.textContent = original;
  }
}

function lastLines(text, count) {
  return String(text).trim().split('\n').slice(-count).join(' | ');
}

function reportIssued(result) {
  reportSteps(result.reused ? 'HTTPS（复用已有证书）' : '自动申请证书', result);
  if (!result.ok) log('证书未签发成功：站点仍以 HTTP 运行或沿用原证书，修正后可点「申请证书」重试', 'warn');
}

function reportSteps(label, result) {
  log(`${label}：${result.ok ? '成功' : '失败'}`, result.ok ? 'ok' : 'bad');
  for (const step of result.steps || []) {
    if (step.detail) log(`  · ${step.step}: ${lastLines(step.detail, 3)}`, step.ok ? '' : 'bad');
  }
}

/* ---------- 登录 ---------- */

function showLogin(message = '') {
  $('#loginOverlay').hidden = false;
  $('#loginError').textContent = message;
  $('#logoutBtn').hidden = true;
}

function hideLogin() {
  $('#loginOverlay').hidden = true;
}

$('#loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  guard(async () => {
    await api('/api/auth/login', {
      method: 'POST',
      body: { username: form.elements.username.value.trim(), password: form.elements.password.value },
    });
    form.reset();
    hideLogin();
    log('登录成功', 'ok');
    await refreshAll();
  });
});

$('#logoutBtn').addEventListener('click', () => guard(async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.me = null;
  showLogin('');
  log('已登出');
}));

/* ---------- 标签页 ---------- */

const TABS = ['sites', 'streams', 'certs', 'logs', 'backups', 'settings'];

function activateTab(name) {
  const target = TABS.includes(name) ? name : TABS[0];
  $$('#tabs .tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === target));
  $$('.view').forEach((view) => { view.hidden = view.id !== `view-${target}`; });
  if (target === 'streams') guard(loadStreams);
  if (target === 'certs') guard(loadCertificates);
  if (target === 'logs') guard(loadLogs);
  if (target === 'backups') guard(loadBackups);
  if (target === 'settings') guard(loadUsers);
}

$('#tabs').addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (!button) return;
  if (location.hash !== `#${button.dataset.tab}`) location.hash = button.dataset.tab;
  else activateTab(button.dataset.tab);
});

window.addEventListener('hashchange', () => activateTab(location.hash.slice(1)));

/* ---------- 概览 ---------- */

async function loadMe() {
  state.me = await api('/api/auth/me');
  if (state.me.authenticated) {
    hideLogin();
    $('#currentUser').textContent = `登录为 ${state.me.username} (${state.me.mode})`;
    $('#logoutBtn').hidden = state.me.mode !== 'session';
  } else if (state.me.requiresAuth) {
    showLogin('');
  } else {
    hideLogin();
    $('#currentUser').textContent = '未启用鉴权';
  }
  syncPasswordBanner();
}

async function loadStatus() {
  const status = await api('/api/status');
  state.status = status;
  const sched = status.scheduler;
  const backup = status.backup;

  const include = status.nginx.include || {};
  const nginxLevel = !status.nginx.installed ? 'bad' : include.ok ? 'ok' : 'warn';
  const nginxTitle = !status.nginx.installed
    ? `未检测到 nginx（${status.nginx.bin || 'nginx'}）`
    : include.ok
      ? `nginx 正常：${status.nginx.version || ''}`
      : `已安装但站点目录没有被 include，配置不会生效：${include.reason || ''}`;
  const certbotTitle = status.certbot.installed
    ? `certbot 正常：${status.certbot.version || ''}${status.certbot.staging ? '（当前为测试环境 staging）' : ''}`
    : `未检测到 certbot（${status.certbot.bin || 'certbot'}）`;

  $('#nginxCard').innerHTML = `<p class="stat-label">nginx</p>
    <p class="stat-value">${statusDot(nginxLevel, nginxTitle)}${statusWord(status.nginx.installed)}</p>
    <p class="stat-note">${esc(status.nginx.version || '未检测到')}</p>
    <p class="stat-note ${include.ok ? 'ok' : 'warn'}">${esc(include.reason)}</p>`;
  $('#certbotCard').innerHTML = `<p class="stat-label">certbot</p>
    <p class="stat-value">${statusDot(status.certbot.installed ? 'ok' : 'bad', certbotTitle)}${statusWord(status.certbot.installed)}</p>
    <p class="stat-note">${esc(String(status.certbot.version || '未检测到').slice(0, 48))}</p>
    <p class="stat-note">webroot: ${esc(status.certbot.webroot)}</p>`;
  $('#schedulerCard').innerHTML = `<p class="stat-label">自动续期</p>
    <p class="stat-value">${sched.enabled ? '已启用' : '已关闭'}</p>
    <p class="stat-note">每 ${esc(sched.intervalMinutes)} 分钟检查一次</p>
    <p class="stat-note">上次: ${esc(sched.lastRun || '尚未执行')}</p>`;
  $('#backupCard').innerHTML = `<p class="stat-label">配置备份</p>
    <p class="stat-value">${backup.enabled ? '已启用' : '已关闭'}</p>
    <p class="stat-note">保留 ${esc(backup.keep)} 份快照</p>
    <p class="stat-note mono">${esc(backup.dir || '-')}</p>`;



  const plat = status.platform || {};
  $('#runtimeInfo').innerHTML = [
    ['操作系统', `${plat.label || '未知'} · ${plat.name || ''}`],
    ['初始化系统', `${plat.init || '未知'}（包管理器 ${plat.packageManager || '未知'}）`],
    ['nginx 运行用户', plat.nginxUser || '-'],
    ['面板地址', `${status.panel.host}:${status.panel.port}`],
    ['面板账号', (status.panel.users || []).join(', ') || '未设置'],
    ['API Token', status.panel.auth ? '已配置' : '未配置'],
    ['nginx 版本', status.nginx.version || '未知'],
    ['配置目录', status.paths.sitesDir],
    ['日志目录', status.paths.logDir],
    ['证书 webroot', status.paths.webroot],
    ['certbot 环境', status.certbot.staging ? '测试 (staging)，浏览器不信任' : '生产'],
    ['备份目录', status.paths.backups || '-'],
    ['站点数量', String(status.sites.length)],
  ].map(([key, value]) => `<span class="k">${esc(key)}</span><span class="v">${esc(value)}</span>`).join('');

  renderSetup(status);
  renderHealth(status.healthcheck);
}

function renderSetup(status) {
  const include = status.nginx.include || {};
  const rows = [
    ['主配置', status.nginx.include?.mainConf || '-'],
    ['站点目录', status.nginx.sitesDir],
    ['加载状态', include.ok ? '已 include 站点目录' : '未 include（配置不会生效）'],
    ['已加载的目录', (include.includes || []).join(', ') || '-'],
    ['nginx 可执行文件', status.nginx.bin || '未检测到'],
    ['certbot webroot', status.certbot.webroot],
  ];
  $('#setupInfo').innerHTML = rows
    .map(([key, value]) => `<span class="k">${esc(key)}</span><span class="v ${key === '加载状态' && !include.ok ? 'bad' : ''}">${esc(value)}</span>`)
    .join('');
  $('#includeBtn').hidden = Boolean(include.ok);
}

$('#includeBtn').addEventListener('click', () => guard(async () => {
  const result = await api('/api/setup/include', { method: 'POST' });
  if (result.ok) log(`include 已写入 ${result.file}（快照 ${result.snapshotId || '-'}）`, 'ok');
  else log(`写入失败: ${result.detail || '未知错误'}${result.restored ? '（已还原主配置）' : ''}`, 'bad');
  for (const attempt of result.reload || []) log(`  · ${attempt.command}: ${attempt.ok ? '成功' : attempt.detail}`, attempt.ok ? '' : 'bad');
  await loadStatus();
}));

/** 状态小圆点：绿=正常，黄=需要关注，红=不可用。 */
function statusDot(level, title) {
  return `<i class="dot ${level}" title="${esc(title)}"></i>`;
}

function statusWord(ok) {
  return ok ? '正常' : '不可用';
}

function badge(ok) {
  return ok ? '<span class="ok">正常</span>' : '<span class="bad">不可用</span>';
}

/* ---------- 站点 ---------- */

/**
 * 近 20 次健康探测的竖条：绿=成功、红=失败、灰=暂无数据（左旧右新）。
 */
function healthBars(site) {
  const history = Array.isArray(site.history) ? site.history.slice(-HEALTH_BARS) : [];
  const pad = HEALTH_BARS - history.length;
  let bars = '';
  for (let index = 0; index < HEALTH_BARS; index += 1) {
    const entry = index < pad ? null : history[index - pad];
    if (!entry) {
      bars += '<span class="bar none"></span>';
      continue;
    }
    const detail = `${new Date(entry.at).toLocaleTimeString()} ${entry.ok ? '成功' : '失败'} · ${entry.latencyMs ?? '-'}ms`
      + `${entry.status ? ` · HTTP ${entry.status}` : ''}${entry.error ? ` · ${entry.error}` : ''}`;
    bars += `<span class="bar ${entry.ok ? 'ok' : 'bad'}" title="${esc(detail)}"></span>`;
  }
  const ok = history.filter((entry) => entry.ok).length;
  const title = history.length
    ? `最近 ${history.length} 次探测：${ok} 次成功 / ${history.length - ok} 次失败（左旧右新）`
    : '暂无健康探测数据：可在「设置 → 健康检查」里启用';
  return `<div class="health-bars" title="${esc(title)}">${bars}</div>`;
}

function healthAutoOn() {
  return localStorage.getItem(HEALTH_AUTO_KEY) !== '0';
}

/** 应用自动刷新开关：勾选后按固定间隔只刷新竖条。 */
function applyHealthAuto() {
  const on = healthAutoOn();
  $('#healthAuto').checked = on;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = on ? setInterval(refreshHealthBars, HEALTH_REFRESH_MS) : null;
}

async function refreshHealthBars() {
  if (document.hidden || healthRefreshing) return;
  if (!state.me || (state.me.requiresAuth && !state.me.authenticated)) return;
  if (!$('#siteList').children.length) return;
  healthRefreshing = true;
  try {
    const sites = (await api('/api/sites')).sites;
    state.sites = sites;
    for (const site of sites) {
      const bars = document.querySelector(`#siteList li[data-site-id="${site.id}"] .health-bars`);
      if (bars) bars.outerHTML = healthBars(site);
    }
    $('#healthAutoLabel').title = `最近刷新：${new Date().toLocaleTimeString()}`;
  } catch (err) {
    if (!err.data?.requiresLogin) log(`健康状态自动刷新失败：${err.message}`, 'warn');
  } finally {
    healthRefreshing = false;
  }
}

$('#healthAuto').addEventListener('change', (event) => {
  localStorage.setItem(HEALTH_AUTO_KEY, event.target.checked ? '1' : '0');
  applyHealthAuto();
  log(event.target.checked ? `健康竖条每 ${HEALTH_REFRESH_MS / 1000} 秒自动刷新` : '已关闭健康竖条自动刷新');
});

async function loadSites() {
  state.sites = (await api('/api/sites')).sites;
  const list = $('#siteList');
  list.innerHTML = '';
  if (!state.sites.length) {
    list.innerHTML = '<li class="muted">还没有站点，点击「新建站点」开始</li>';
    resetForm();
    return;
  }
  for (const site of state.sites) {
    const li = document.createElement('li');
    li.dataset.siteId = site.id;
    if (state.current?.id === site.id) li.classList.add('active');
    li.innerHTML = `<div class="site-body">
        <div class="name">${esc(site.name)}
          <span class="pill ${site.enabled ? 'ok' : ''}">${site.enabled ? '启用' : '停用'}</span>
          ${site.ssl.enabled ? '<span class="pill ok">HTTPS</span>' : ''}
          ${site.ssl.enabled && site.httpEnabled === false ? '<span class="pill warn">仅 HTTPS</span>' : ''}
          ${site.upstream.websocket ? '<span class="pill warn">WS</span>' : ''}</div>
        <div class="meta">${esc(site.serverNames.join(', '))}</div>
        <div class="meta">→ ${esc(`${site.upstream.scheme}://${site.upstream.host}:${site.upstream.port}`)}</div>
      </div>
      ${healthBars(site)}
      <div class="site-actions"></div>`;

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary-light btn-compact';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', (event) => { event.stopPropagation(); selectSite(site); openSiteModal(); });

    const stateBtn = document.createElement('button');
    stateBtn.className = 'btn btn-secondary-light btn-compact';
    stateBtn.textContent = site.enabled ? '停用' : '启用';
    stateBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      guard(async () => {
        const result = await api(`/api/sites/${site.id}/apply`, { method: 'POST', body: { enabled: !site.enabled } });
        reportSteps(result.site.enabled ? '启用站点' : '停用站点', result);
        await loadSites();
      });
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-danger btn-compact';
    removeBtn.textContent = '删除';
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      guard(async () => {
        if (!window.confirm(`确认删除站点 ${site.name} 并移除其 nginx 配置？`)) return;
        await api(`/api/sites/${site.id}`, { method: 'DELETE' });
        log(`站点 ${site.name} 已删除`, 'ok');
        if (state.current?.id === site.id) resetForm();
        await loadSites();
      });
    });

    li.lastElementChild.append(editBtn, stateBtn, removeBtn);
    li.addEventListener('click', () => { selectSite(site); openSiteModal(); });
    list.appendChild(li);
  }
  // 默认选中第一个站点，让表单有内容可看；但正在「新建站点」弹窗里填表时不要动表单，
  // 否则列表刷新（刷新按钮 / 保存后）会把用户填的内容换成别的站点，保存时就覆盖了那个站点。
  if (formMode === 'create' && !$('#siteOverlay').hidden) return;
  const current = state.current && state.sites.find((site) => site.id === state.current.id);
  selectSite(current || state.sites[0]);
}

function selectSite(site) {
  state.current = site;
  formMode = 'edit';
  const form = $('#siteForm');
  form.reset();
  form.elements.id.value = site.id;
  form.elements.name.value = site.name;
  form.elements.serverNames.value = site.serverNames.join(' ');
  form.elements['upstream.scheme'].value = site.upstream.scheme;
  form.elements['upstream.host'].value = site.upstream.host;
  form.elements['upstream.port'].value = site.upstream.port;
  form.elements.listenHttp.value = site.listenHttp;
  form.elements.listenHttps.value = site.listenHttps;
  form.elements['upstream.websocket'].checked = site.upstream.websocket;
  form.elements['ssl.enabled'].checked = site.ssl.enabled;
  form.elements.noHttp.checked = site.httpEnabled === false;
  form.elements['ssl.autoRenew'].checked = site.ssl.autoRenew;
  form.elements['ssl.staging'].checked = site.ssl.staging;
  form.elements['ssl.email'].value = site.ssl.email || '';
  form.elements['ssl.certPath'].value = site.ssl.certPath || '';
  form.elements['ssl.keyPath'].value = site.ssl.keyPath || '';
  form.elements.enabled.checked = site.enabled;
  form.elements['advanced.clientMaxBodySize'].value = site.advanced.clientMaxBodySize;
  form.elements['advanced.healthCheckPath'].value = site.advanced.healthCheckPath || '';
  form.elements['advanced.extraHeaders'].value = site.advanced.extraHeaders.join('\n');
  form.elements['advanced.extraLocations'].value = site.advanced.extraLocations || '';
  $('#formTitle').textContent = `编辑：${site.name}`;
  $('#formHint').textContent = site.confFile || site.id;
  setFormStatus('');
  syncSchemeFields();
  const items = $$('#siteList li');
  items.forEach((li) => li.classList.remove('active'));
  const index = state.sites.findIndex((item) => item.id === site.id);
  if (items[index]) items[index].classList.add('active');
}

function resetForm() {
  state.current = null;
  formMode = 'create';
  const form = $('#siteForm');
  form.reset();
  // <input type="hidden"> 的 value 会同步进 HTML 属性，form.reset() 会把它当默认值恢复回来，
  // 所以必须显式清空，否则「编辑过站点 → 新建站点」会带着上一个站点的 id 提交成更新。
  form.elements.id.value = '';
  form.elements['upstream.host'].value = '127.0.0.1';
  form.elements['upstream.port'].value = 8080;
  form.elements.listenHttp.value = 80;
  form.elements.listenHttps.value = 443;
  form.elements['advanced.clientMaxBodySize'].value = '64m';
  form.elements['ssl.autoRenew'].checked = true;
  form.elements.enabled.checked = true;
  form.elements.noHttp.checked = false;
  $('#formTitle').textContent = '新建站点';
  $('#formHint').textContent = '填写后保存即可生成 nginx 配置';
  setFormStatus('');
  syncSchemeFields();
}

/**
 * gRPC 上游：WebSocket 头没有意义、HTTP 探测也不适用，切换协议时同步这两个字段的可用性。
 */
function syncSchemeFields() {
  const form = $('#siteForm');
  if (!form) return;
  const grpc = ['grpc', 'grpcs'].includes(form.elements['upstream.scheme'].value);
  form.elements['upstream.websocket'].closest('label').hidden = grpc;
  const health = $('#healthPathLabel');
  health.title = grpc ? 'gRPC 上游只做 TCP 探测，这里的路径不生效' : '';
  health.classList.toggle('muted', grpc);
}

function formPayload() {
  const form = $('#siteForm');
  const value = (name) => form.elements[name];
  return {
    name: value('name').value.trim(),
    serverNames: value('serverNames').value.trim(),
    listenHttp: Number(value('listenHttp').value) || 80,
    listenHttps: Number(value('listenHttps').value) || 443,
    enabled: value('enabled').checked,
    httpEnabled: !value('noHttp').checked,
    upstream: {
      scheme: value('upstream.scheme').value,
      host: value('upstream.host').value.trim(),
      port: Number(value('upstream.port').value),
      websocket: value('upstream.websocket').checked,
    },
    ssl: {
      enabled: value('ssl.enabled').checked,
      autoRenew: value('ssl.autoRenew').checked,
      staging: value('ssl.staging').checked,
      email: value('ssl.email').value.trim(),
      certPath: value('ssl.certPath').value.trim(),
      keyPath: value('ssl.keyPath').value.trim(),
    },
    advanced: {
      clientMaxBodySize: value('advanced.clientMaxBodySize').value.trim() || '64m',
      extraHeaders: value('advanced.extraHeaders').value.split('\n').map((line) => line.trim()).filter(Boolean),
      extraLocations: value('advanced.extraLocations').value,
      healthCheckPath: value('advanced.healthCheckPath').value.trim(),
    },
  };
}

$('#siteForm').elements['upstream.scheme'].addEventListener('change', syncSchemeFields);

$('#newSiteBtn').addEventListener('click', () => {
  resetForm();
  $$('#siteList li').forEach((li) => li.classList.remove('active'));
  openSiteModal();
});

$('#siteModalClose').addEventListener('click', () => closeSiteModal());
$('#siteOverlay').addEventListener('click', (event) => { if (event.target === $('#siteOverlay')) closeSiteModal(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#siteOverlay').hidden) closeSiteModal();
});

$('#siteForm').addEventListener('submit', (event) => {
  event.preventDefault();
  guard(async () => {
    const payload = formPayload();
    if (!payload.httpEnabled && !payload.ssl.enabled) {
      setFormStatus('「关闭 HTTP」必须同时勾选「启用 HTTPS」，否则站点没有可访问的入口', 'bad');
      return;
    }
    // 以 state.current 为准：只有明确选中了站点才是更新，避免隐藏字段残留 id 导致覆盖别的站点
    const id = state.current?.id || '';
    const submitBtn = $('#siteForm').querySelector('button[type="submit"]');
    const needsCert = payload.ssl.enabled && (!payload.ssl.certPath || !payload.ssl.keyPath);
    const data = await withBusy(submitBtn, '正在保存…', async () => {
      if (needsCert) log('保存中：勾选了 HTTPS 且未填证书路径，将自动申请证书（可能需要 10-60 秒）…');
      return id
        ? api(`/api/sites/${id}`, { method: 'PUT', body: payload })
        : api('/api/sites', { method: 'POST', body: payload });
    });
    log(`${id ? '更新' : '创建'}站点 ${data.site.name}`, 'ok');
    if (data.applied) reportSteps('应用配置', data.applied);
    if (data.issued) reportIssued(data.issued);
    if (data.pending) log('已保存：勾选了 HTTPS 但尚未签发证书，申请成功后会切到 HTTPS', 'warn');
    await loadSites();
    selectSite(data.site);
    setFormStatus(data.issued && !data.issued.ok
      ? '站点已保存，但证书未签发，暂时以 HTTP 运行（详见下方输出）'
      : '配置已保存并应用', data.issued && !data.issued.ok ? 'bad' : 'ok');
  });
});

$('#pruneBtn').addEventListener('click', () => guard(async () => {
  const result = await api('/api/sites/prune', { method: 'POST' });
  if (!result.removed.length) log('没有发现失效配置', 'ok');
  else log(`已清理 ${result.removed.length} 个失效配置: ${result.removed.join(', ')}`, 'ok');
}));

$('#applyAllBtn').addEventListener('click', () => guard(async () => {
  const result = await api('/api/sites/apply-all', { method: 'POST' });
  log(`批量应用：成功 ${result.results.filter((item) => item.ok).length}/${result.results.length}`, result.ok ? 'ok' : 'bad');
  for (const item of result.results.filter((entry) => !entry.ok)) log(`  · ${item.name} 失败`, 'bad');
  await loadSites();
}));

/* ---------- 证书 ---------- */

async function loadCertificates() {
  const data = await api('/api/certificates');
  state.certs = data.certificates;
  const tbody = $('#certTable tbody');
  tbody.innerHTML = '';
  if (!data.installed) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">未检测到 certbot</td></tr>';
    return;
  }
  if (!data.certificates.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">暂无证书</td></tr>';
    return;
  }
  for (const cert of data.certificates) {
    const cls = cert.daysLeft === null ? '' : cert.daysLeft < 14 ? 'bad' : cert.daysLeft < 30 ? 'warn' : 'ok';
    const linked = cert.sites || [];
    const sites = linked.length
      ? linked.map((site) => `${esc(site.name)}${site.enabled ? '' : '（停用）'}`).join('、')
      : '<span class="muted">未关联站点</span>';
    const badge = cert.staging ? '<span class="pill warn">测试证书</span> ' : '';
    const del = linked.length
      ? '<span class="muted" title="仍被站点引用，先在站点里取消启用 HTTPS 或更换证书">不可删除</span>'
      : `<button class="btn btn-danger btn-compact" data-cert="${esc(cert.name)}">删除</button>`;
    tbody.innerHTML += `<tr><td class="mono">${badge}${esc(cert.name)}</td><td class="mono">${esc(cert.domains.join(' '))}</td>
      <td>${esc(cert.expiresAt ? new Date(cert.expiresAt).toLocaleString() : '未知')}</td>
      <td><span class="pill ${cls}">${cert.daysLeft === null ? '?' : `${cert.daysLeft} 天`}</span></td>
      <td>${sites}</td><td>${del}</td></tr>`;
  }
  tbody.querySelectorAll('button[data-cert]').forEach((btn) => btn.addEventListener('click', () => guard(async () => {
    const name = btn.dataset.cert;
    if (!window.confirm(`确认删除证书 ${name}？会移除该证书的文件，且不可恢复。`)) return;
    const result = await api(`/api/certificates/${encodeURIComponent(name)}`, { method: 'DELETE' });
    log(`删除证书 ${name}：${result.ok ? '成功' : '失败'} ${result.detail || ''}`, result.ok ? 'ok' : 'bad');
    await loadCertificates();
    await loadSites();
  })));
}

$('#renewBtn').addEventListener('click', () => guard(async () => {
  const result = await api('/api/certificates/renew', { method: 'POST' });
  log(`续期检查：${result.ok ? '成功' : '失败'}${result.skipped ? '（已跳过）' : ''} ${result.detail || ''}`, result.ok ? 'ok' : 'bad');
  await loadCertificates();
}));

$('#reloadCertsBtn').addEventListener('click', () => guard(loadCertificates));

/* ---------- 日志 ---------- */

async function loadLogs() {
  const select = $('#logSiteSelect');
  const keep = select.value;
  select.innerHTML = '<option value="">全部站点</option>';
  for (const site of state.sites) select.innerHTML += `<option value="${site.id}">${esc(site.name)}</option>`;
  select.value = state.sites.some((site) => site.id === keep) ? keep : '';

  const hours = $('#logHours').value;
  const query = `hours=${hours}&top=${LOGS_TOP_LIMIT}${select.value ? `&siteId=${select.value}` : ''}`;
  const stats = await api(`/api/logs?${query}`);

  $('#logStats').innerHTML = [
    ['请求数', stats.total],
    ['流量', bytes(stats.bytes)],
    ['错误率', `${(stats.errorRate * 100).toFixed(2)}%`],
    ['4xx / 5xx', `${stats.statusClasses['4xx']} / ${stats.statusClasses['5xx']}`],
  ].map(([label, value]) => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`).join('');

  const timeline = stats.timeline;
  const max = Math.max(1, ...timeline.map((point) => point.count));
  const tick = (hour) => new Date(hour).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const tickIndexes = timeline.length > 40 ? [0, Math.floor((timeline.length - 1) / 4), Math.floor((timeline.length - 1) / 2), Math.floor(((timeline.length - 1) * 3) / 4), timeline.length - 1] : [0, Math.floor((timeline.length - 1) / 2), timeline.length - 1];

  // 纵轴：最大值 / 中值 / 0；横轴：按数据量取 3 或 5 个时间刻度
  $('#logYAxis').innerHTML = timeline.length
    ? [max, Math.round(max / 2), 0].map((value) => `<span>${value}</span>`).join('')
    : '';
  $('#logXAxis').innerHTML = timeline.length
    ? [...new Set(tickIndexes)].map((index) => `<span>${esc(tick(timeline[index].hour))}</span>`).join('')
    : '';
  $('#logTimeline').innerHTML = timeline.length
    ? timeline.map((point) => `<div class="bar" style="height:${Math.round((point.count / max) * 100)}%" title="${esc(tick(point.hour))} · ${point.count} 次"></div>`).join('')
    : '<span class="chart-empty muted small">该时间范围内没有日志</span>';

  state.tops = { paths: stats.topPaths || [], ips: stats.topIPs || [], agents: stats.topAgents || [] };
  state.topsExpanded = { paths: false, ips: false, agents: false };
  renderTops();

  $('#logRecent').textContent = stats.recent.length
    ? stats.recent.map((row) => `${row.at ? new Date(row.at).toLocaleString() : '-'}  ${row.ip}  ${row.method} ${row.path}  ${row.status}  ${bytes(row.bytes)}`).join('\n')
    : '暂无数据';

  const missing = stats.files.filter((file) => !file.exists);
  if (missing.length) log(`提示：${missing.length} 个站点的访问日志文件还不存在（站点未产生流量时正常）`, 'warn');
}

function group(title, rows, key) {
  const expanded = Boolean(state.topsExpanded[key]);
  const visible = expanded ? rows : rows.slice(0, TOP_PREVIEW);
  const body = visible.length
    ? visible.map((row) => `<div class="row-item"><span title="${esc(row.key)}">${esc(row.key)}</span><span class="muted">${row.count}</span></div>`).join('')
    : '<div class="muted small">暂无数据</div>';
  const toggle = rows.length > TOP_PREVIEW
    ? `<button type="button" class="btn btn-secondary-light btn-compact" data-tops-toggle="${key}">${expanded ? '收起' : `更多（${rows.length}）`}</button>`
    : '';
  return `<div class="group"><div class="group-head"><h4>${esc(title)}</h4><div class="spacer"></div>${toggle}</div>${body}</div>`;
}

function renderTops() {
  $('#logTops').innerHTML = group('Top URL', state.tops.paths || [], 'paths')
    + group('Top IP', state.tops.ips || [], 'ips')
    + group('Top UA', state.tops.agents || [], 'agents');
}

$('#logTops').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tops-toggle]');
  if (!button) return;
  const key = button.dataset.topsToggle;
  state.topsExpanded[key] = !state.topsExpanded[key];
  renderTops();
});

$('#loadLogsBtn').addEventListener('click', () => guard(loadLogs));
$('#logHours').addEventListener('change', () => guard(loadLogs));

/* ---------- TCP / UDP 转发 ---------- */

function setStreamFormStatus(message, kind = '') {
  const el = $('#streamFormStatus');
  if (!el) return;
  el.hidden = !message;
  el.className = `body-sm ${kind || 'body-light'}`;
  el.textContent = message || '';
}

async function loadStreams() {
  const data = await api('/api/streams');
  state.streams = data.streams;
  state.streamInfo = data;

  const module = data.module || {};
  const include = data.include || {};
  const notes = [];
  if (module.known === false) notes.push('无法识别 nginx 编译参数，stream 支持交给 nginx -t 判断');
  else if (module.ok) notes.push(`stream 模块正常（${module.detail}）`);
  else notes.push(`stream 模块不可用：${module.detail}${module.hint ? `；${module.hint}` : ''}`);
  notes.push(include.ok
    ? `主配置已用 stream {} 块加载 ${data.dir}`
    : `${include.mode === 'top-level' ? 'include 写在了顶层作用域（server 块不会生效）' : '主配置里还没有 stream {} 块'}：${data.dir}`);
  const status = $('#streamStatus');
  status.textContent = notes.join(' · ');
  const streamBad = (module.known !== false && !module.ok) || include.mode === 'top-level';
  status.className = `body-sm ${streamBad ? 'bad' : include.ok ? 'body-light' : 'warn'}`;
  $('#streamIncludeBtn').hidden = Boolean(include.ok);

  const list = $('#streamList');
  list.innerHTML = '';
  if (!data.streams.length) {
    list.innerHTML = '<li class="muted">还没有转发规则；新建后每条规则会在 stream 目录里生成一个独立 conf</li>';
    return;
  }
  for (const rule of data.streams) {
    const li = document.createElement('li');
    const target = `→ ${rule.backend.host}:${rule.backend.port}`;
    li.innerHTML = `<div class="site-body">
        <div class="name">${esc(rule.name || `端口 ${rule.listenPort}`)}
          <span class="pill ${rule.enabled ? 'ok' : ''}">${rule.enabled ? '启用' : '停用'}</span>
          <span class="pill warn">${esc(rule.protocol.toUpperCase())}</span></div>
        <div class="meta">监听 ${esc(`${rule.listenAddress || '*'}:${rule.listenPort}`)} ${esc(target)}</div>
        <div class="meta">${esc(rule.confFile || '')}</div>
      </div>
      <div class="site-actions"></div>`;

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary-light btn-compact';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', (event) => { event.stopPropagation(); selectStream(rule); openStreamModal(); });

    const stateBtn = document.createElement('button');
    stateBtn.className = 'btn btn-secondary-light btn-compact';
    stateBtn.textContent = rule.enabled ? '停用' : '启用';
    stateBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      guard(async () => {
        const result = await api(`/api/streams/${rule.id}/apply`, { method: 'POST', body: { enabled: !rule.enabled } });
        log(`${result.stream.enabled ? '启用' : '停用'}转发 ${result.stream.name || result.stream.listenPort}：${result.ok ? '成功' : '失败'}`, result.ok ? 'ok' : 'bad');
        await loadStreams();
      });
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-danger btn-compact';
    removeBtn.textContent = '删除';
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      guard(async () => {
        if (!window.confirm(`确认删除转发规则 ${rule.name || rule.listenPort} 并移除其配置？`)) return;
        await api(`/api/streams/${rule.id}`, { method: 'DELETE' });
        log(`转发规则 ${rule.name || rule.listenPort} 已删除`, 'ok');
        if (state.currentStream?.id === rule.id) resetStreamForm();
        await loadStreams();
      });
    });

    li.lastElementChild.append(editBtn, stateBtn, removeBtn);
    li.addEventListener('click', () => { selectStream(rule); openStreamModal(); });
    list.appendChild(li);
  }
}

function openStreamModal() { $('#streamOverlay').hidden = false; }
function closeStreamModal() { $('#streamOverlay').hidden = true; }

function resetStreamForm() {
  state.currentStream = null;
  const form = $('#streamForm');
  form.reset();
  // hidden input 的 value 会同步进 HTML 属性，必须显式清空，否则「编辑过 → 新建」会提交成更新
  form.elements.id.value = '';
  form.elements.protocol.value = 'tcp';
  form.elements.listenAddress.value = '';
  form.elements.listenPort.value = 8443;
  form.elements['backend.host'].value = '127.0.0.1';
  form.elements['backend.port'].value = 443;
  form.elements.proxyTimeoutSeconds.value = 600;
  form.elements.enabled.checked = true;
  $('#streamFormTitle').textContent = '新建 TCP 转发';
  $('#streamFormHint').textContent = '';
  setStreamFormStatus('');
}

function selectStream(rule) {
  state.currentStream = rule;
  const form = $('#streamForm');
  form.reset();
  form.elements.id.value = rule.id;
  form.elements.name.value = rule.name || '';
  form.elements.protocol.value = rule.protocol;
  form.elements.listenAddress.value = rule.listenAddress || '';
  form.elements.listenPort.value = rule.listenPort;
  form.elements['backend.host'].value = rule.backend.host;
  form.elements['backend.port'].value = rule.backend.port;
  form.elements.proxyTimeoutSeconds.value = rule.proxyTimeoutSeconds;
  form.elements.enabled.checked = rule.enabled;
  $('#streamFormTitle').textContent = `编辑：${rule.name || rule.listenPort}`;
  $('#streamFormHint').textContent = rule.confFile || rule.id;
  setStreamFormStatus('');
}

function streamPayload() {
  const form = $('#streamForm');
  const value = (name) => form.elements[name];
  return {
    name: value('name').value.trim(),
    protocol: value('protocol').value,
    listenAddress: value('listenAddress').value.trim(),
    listenPort: Number(value('listenPort').value),
    backend: { host: value('backend.host').value.trim(), port: Number(value('backend.port').value) },
    proxyTimeoutSeconds: Number(value('proxyTimeoutSeconds').value),
    enabled: value('enabled').checked,
  };
}

$('#newStreamBtn').addEventListener('click', () => { resetStreamForm(); openStreamModal(); });
$('#streamModalClose').addEventListener('click', () => closeStreamModal());
$('#streamOverlay').addEventListener('click', (event) => { if (event.target === $('#streamOverlay')) closeStreamModal(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#streamOverlay').hidden) closeStreamModal();
});

$('#streamIncludeBtn').addEventListener('click', () => guard(async () => {
  const result = await api('/api/setup/stream-include', { method: 'POST' });
  if (result.ok) log(result.already ? `stream include 已就绪（${result.snippet}）` : `${result.detail || `已写入 ${result.file} 并 reload`}`, 'ok');
  else log(`写入失败：${result.detail || '未知错误'}${result.restored ? '（已还原主配置）' : ''}`, 'bad');
  await loadStreams();
}));

$('#streamApplyAllBtn').addEventListener('click', () => guard(async () => {
  const result = await api('/api/streams/apply-all', { method: 'POST' });
  log(`批量应用转发规则 ${result.results.filter((item) => item.ok).length}/${result.results.length} 成功`, result.ok ? 'ok' : 'warn');
  await loadStreams();
}));

$('#streamForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const id = form.elements.id.value;
  const payload = streamPayload();
  setStreamFormStatus('保存中…');
  try {
    const result = id
      ? await api(`/api/streams/${id}`, { method: 'PUT', body: payload })
      : await api('/api/streams', { method: 'POST', body: payload });
    const applied = result.applied || {};
    const label = result.stream.name || result.stream.listenPort;
    if (applied.ok) log(`${id ? '更新' : '新增'} TCP 转发 ${label} 已生效`, 'ok');
    else log(`${id ? '更新' : '新增'} TCP 转发 ${label} 未生效`, 'warn');
    for (const step of applied.steps || []) {
      if (!step.ok) log(`  · ${step.step}: ${lastLines(step.detail, 3)}`, 'bad');
    }
    closeStreamModal();
    await loadStreams();
  } catch (err) {
    setStreamFormStatus(err.message, 'bad');
  }
});

/* ---------- 备份 ---------- */

async function loadBackups() {
  const data = await api('/api/backups?limit=200');
  state.backups = data.backups;
  const manual = data.backups.filter((item) => item.manual);
  const auto = data.backups.filter((item) => !item.manual);

  $('#manualBackupNote').textContent = manual.length
    ? `共 ${manual.length} 份。手动快照永久保留，不会被自动清理。`
    : '还没有手动快照：填个备注点「创建快照」，就能长期留存一份当前配置。';
  $('#autoBackupNote').textContent = `每次应用 / 删除站点自动生成，只保留最近 ${data.keep} 份（当前 ${auto.length} 份），超出后自动清理。`;

  fillBackupTable($('#manualBackupTable tbody'), manual, '手动快照');
  fillBackupTable($('#autoBackupTable tbody'), auto, '自动快照');
}

function fillBackupTable(tbody, items, label) {
  tbody.innerHTML = '';
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">暂无${label}</td></tr>`;
    return;
  }
  for (const item of items) tbody.appendChild(backupRow(item));
}

function backupRow(item) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${esc(new Date(item.at).toLocaleString())}</td>
      <td>${esc(item.reason)}</td>
      <td class="mono">${item.files.length} 个文件</td>
      <td></td>`;
  const cell = tr.lastElementChild;

  const restore = document.createElement('button');
  restore.className = 'btn btn-secondary-light btn-compact';
  restore.textContent = '回滚';
  restore.addEventListener('click', () => guard(async () => {
    if (!window.confirm('确认回滚到该快照？当前配置会被覆盖。')) return;
    const result = await api(`/api/backups/${item.id}/restore`, { method: 'POST' });
    log(`回滚 ${item.id}: ${result.ok ? '成功' : '失败'} (${result.files.map((file) => file.action).join(', ')})`, result.ok ? 'ok' : 'bad');
    await loadSites();
  }));

  const del = document.createElement('button');
  del.className = 'btn btn-danger btn-compact';
  del.textContent = '删除';
  del.addEventListener('click', () => guard(async () => {
    await api(`/api/backups/${item.id}`, { method: 'DELETE' });
    await loadBackups();
  }));

  cell.append(restore, del);
  return tr;
}

$('#createBackupBtn').addEventListener('click', () => guard(async () => {
  const result = await api('/api/backups', { method: 'POST', body: { reason: $('#backupReason').value.trim() } });
  log(`已创建手动快照 ${result.id}（${result.files} 个文件，永久保留）`, 'ok');
  $('#backupReason').value = '';
  await loadBackups();
}));

/* ---------- 设置 ---------- */

function renderHealth(health) {
  const form = $('#healthForm');
  if (!form || !health) return;
  state.health = health;
  form.elements.enabled.checked = health.enabled !== false;
  form.elements.intervalSeconds.value = health.intervalSeconds;
  form.elements.timeoutMs.value = health.timeoutMs;
  form.elements.path.value = health.path || '';
  const status = $('#healthStatus');
  const last = health.lastResult;
  status.textContent = last
    ? `最近一轮：${health.lastRun || '-'}，${last.ok}/${last.total} 个站点探测成功`
    : '尚未执行过探测';
  status.hidden = false;
}

$('#saveHealthBtn').addEventListener('click', () => guard(async () => {
  const form = $('#healthForm');
  const result = await api('/api/settings/healthcheck', {
    method: 'PUT',
    body: {
      enabled: form.elements.enabled.checked,
      intervalSeconds: Number(form.elements.intervalSeconds.value),
      timeoutMs: Number(form.elements.timeoutMs.value),
      path: form.elements.path.value.trim(),
    },
  });
  log(`健康检查设置已保存：每 ${result.healthcheck.intervalSeconds} 秒探测，超时 ${result.healthcheck.timeoutMs}ms${result.healthcheck.path ? `，路径 ${result.healthcheck.path}` : ''}`, 'ok');
  await loadStatus();
}));

async function loadUsers() {
  const data = await api('/api/auth/users');
  state.users = data.users;
  const tbody = $('#userTable tbody');
  tbody.innerHTML = '';
  $('#changePwdBtn').hidden = state.me?.mode !== 'session';
  if (!data.users.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted">未配置账号，面板处于无鉴权模式</td></tr>';
    return;
  }
  for (const user of data.users) {
    const tr = document.createElement('tr');
    const badge = user.mustChangePassword ? ' <span class="pill warn">待改密</span>' : '';
    tr.innerHTML = `<td>${esc(user.username)}${badge}</td><td>${esc(new Date(user.updatedAt || user.createdAt).toLocaleString())}</td><td></td>`;
    const cell = tr.lastElementChild;

    if (user.username !== state.me?.username) {
      const reset = document.createElement('button');
      reset.className = 'btn btn-secondary-light btn-compact';
      reset.textContent = '重置密码';
      reset.addEventListener('click', () => openUserForm('reset', user.username));
      cell.appendChild(reset);
    }

    if (state.users.length > 1) {
      const del = document.createElement('button');
      del.className = 'btn btn-danger btn-compact';
      del.textContent = '删除';
      del.addEventListener('click', () => guard(async () => {
        if (!window.confirm(`删除账号 ${user.username}？`)) return;
        await api(`/api/auth/users/${encodeURIComponent(user.username)}`, { method: 'DELETE' });
        await loadUsers();
      }));
      cell.appendChild(del);
    }

    tbody.appendChild(tr);
  }
}

/* 同一个表单三种用途：self 改自己的密码 / reset 重置他人密码 / new 新增账号。 */
let userFormMode = 'self';

function openUserForm(mode, username = '') {
  const form = $('#userForm');
  userFormMode = mode;
  form.hidden = false;
  form.reset();
  $('#userFormStatus').textContent = '';
  $('#userFormTitle').textContent = {
    self: '修改我的密码',
    reset: `重置 ${username} 的密码`,
    new: '新增账号',
  }[mode];
  form.elements.username.readOnly = mode !== 'new';
  form.elements.username.value = mode === 'new' ? '' : (username || state.me?.username || '');
  if (mode === 'new') form.elements.username.focus();
  else form.elements.password.focus();
}

function closeUserForm() {
  const form = $('#userForm');
  form.hidden = true;
  form.reset();
  $('#userFormStatus').textContent = '';
}

$('#changePwdBtn').addEventListener('click', () => openUserForm('self', state.me?.username || ''));
$('#newUserBtn').addEventListener('click', () => openUserForm('new'));
$('#cancelUserBtn').addEventListener('click', closeUserForm);

$('#userForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const status = $('#userFormStatus');
  status.textContent = '';
  if (form.elements.password.value !== form.elements.confirm.value) {
    status.textContent = '两次输入的密码不一致';
    return;
  }
  const mode = userFormMode;
  const username = mode === 'new' ? form.elements.username.value.trim() : form.elements.username.value;
  guard(async () => {
    if (mode === 'self') {
      await api('/api/auth/password', { method: 'POST', body: { password: form.elements.password.value } });
      log('密码已更新', 'ok');
    } else {
      await api('/api/auth/users', {
        method: 'POST',
        body: { username, password: form.elements.password.value },
      });
      log(mode === 'reset' ? `已重置 ${username} 的密码` : '账号已保存', 'ok');
    }
    closeUserForm();
    await loadUsers();
    if (mode === 'self') await loadMe();
  });
});

/* ---------- 默认密码提示 ---------- */

/** 仍在使用默认密码时，在「设置 → 修改我的密码」上方给出醒目提示。 */
function syncPasswordBanner() {
  const banner = $('#pwdBanner');
  banner.hidden = !state.me?.mustChangePassword;
  if (state.me?.mustChangePassword) {
    banner.textContent = `面板正在使用默认密码 ${state.me.username}/admin，请立即修改；修改后其他设备的登录会失效。`;
  }
}

/* ---------- 启动 ---------- */

$('#refreshBtn').addEventListener('click', () => guard(async () => { await refreshAll(); log('状态已刷新'); }));
$('#clearLogBtn').addEventListener('click', () => { $('#log').textContent = ''; });

async function refreshAll() {
  await loadMe();
  if (!state.me.authenticated && state.me.requiresAuth) return;
  await loadStatus();
  await loadSites();
  if (state.current) {
    const fresh = state.sites.find((site) => site.id === state.current.id);
    if (fresh) selectSite(fresh);
  }
}

guard(async () => {
  if (state.token) log('使用 API token 访问面板');
  await refreshAll();
  applyHealthAuto();
  if (state.me.mustChangePassword) {
    activateTab('settings');
    openUserForm('self', state.me.username);
    log('面板仍在使用默认密码，请先修改密码', 'warn');
  } else {
    activateTab(location.hash.slice(1) || 'sites');
  }
});
