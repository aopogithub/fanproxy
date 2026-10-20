'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { run, resolveBinary } = require('./exec');

/**
 * nginx 封装。跨发行版要点：
 * - 主配置位置随发行版不同（/etc/nginx 或 /usr/local/etc/nginx），由 platform 层给出默认值
 * - 站点目录在不同发行版里可能是 conf.d / http.d / sites-enabled，include 检测用解析而非字符串匹配
 * - reload 优先 `nginx -s reload`，失败后回退到发行版的服务管理器
 */
class Nginx {
  constructor(config) {
    this.config = config.nginx;
    this.platform = config.platform || null;
    this.bin = resolveBinary(this.config.bin);
  }

  get installed() {
    return Boolean(this.bin);
  }

  baseArgs() {
    const args = [];
    if (this.config.mainConf && fs.existsSync(this.config.mainConf)) {
      args.push('-c', this.config.mainConf);
    }
    return args;
  }

  async version() {
    if (!this.installed) return null;
    if (this.cachedVersion !== undefined) return this.cachedVersion;
    const result = await run(this.bin, ['-v']);
    this.cachedVersion = `${result.stderr}${result.stdout}`.trim() || null;
    // 渲染层据此决定 gRPC 站点用 `http2 on;`（1.25.1+）还是 `listen ... http2`（旧版兼容）
    this.config.detectedVersion = this.cachedVersion;
    this.config.http2Directive = versionAtLeast(this.cachedVersion, 1, 25, 1);
    return this.cachedVersion;
  }

  async test() {
    if (!this.installed) {
      return { ok: false, code: 127, stdout: '', stderr: 'nginx 未安装或不在 PATH 中' };
    }
    return run(this.bin, [...this.baseArgs(), '-t']);
  }

  /** 先尝试 `nginx -s reload`，失败再退回 systemd/openrc/sysv。 */
  async reload() {
    if (!this.installed) {
      return { ok: false, code: 127, stdout: '', stderr: 'nginx 未安装或不在 PATH 中' };
    }

    const attempts = [];
    const primary = await run(this.bin, [...this.baseArgs(), '-s', 'reload']);
    attempts.push({ command: `${this.config.bin} -s reload`, ok: primary.ok, detail: tail(primary) });
    if (primary.ok) return { ...primary, attempts };

    for (const [bin, args] of this.platform?.reloadFallbacks || []) {
      const result = await run(bin, args);
      attempts.push({ command: `${bin} ${args.join(' ')}`, ok: result.ok, detail: tail(result) });
      if (result.ok) return { ...result, attempts };
    }

    return { ...primary, attempts, stderr: attempts.map((item) => `${item.command}: ${item.detail}`).join('\n') };
  }

  /** 解析主配置里的 include（含一层递归），返回被引用的目录列表。 */
  includedDirs() {
    const mainConf = this.config.mainConf;
    return [...new Set(collectIncludes(mainConf))];
  }

  /**
   * 判断站点目录是否已经被 nginx 主配置加载。
   * 兼容 `include /etc/nginx/conf.d/*.conf;`、`include conf.d/*.conf;`、以及 sites-enabled 之类的中转目录。
   */
  checkInclude() {
    const mainConf = this.config.mainConf;
    const sitesDir = path.resolve(this.config.sitesDir);
    if (!mainConf || !fs.existsSync(mainConf)) {
      return { ok: false, reason: `主配置不存在: ${mainConf || '(未配置)'}`, snippet: `include ${this.config.sitesDir}/*.conf;`, includes: [] };
    }

    const dirs = this.includedDirs();
    const covered = dirs.some((dir) => {
      const resolved = path.resolve(dir);
      return resolved === sitesDir || sitesDir.startsWith(`${resolved}${path.sep}`);
    });

    return {
      ok: covered,
      mainConf,
      sitesDir: this.config.sitesDir,
      reason: covered
        ? `已包含站点目录（${dirs.filter((d) => path.resolve(d) === sitesDir).join(', ') || sitesDir}）`
        : `主配置未 include ${this.config.sitesDir}`,
      snippet: `include ${this.config.sitesDir}/*.conf;`,
      includes: dirs,
    };
  }

  /** 把 include 写进主配置的 http {} 块；写坏会被调用方还原。 */
  addInclude() {
    const check = this.checkInclude();
    if (check.ok) return { ok: true, already: true, ...check };

    const mainConf = this.config.mainConf;
    if (!mainConf || !fs.existsSync(mainConf)) {
      return { ok: false, detail: `主配置不存在: ${mainConf || '(未配置)'}` };
    }

    const content = fs.readFileSync(mainConf, 'utf8');
    const httpMatch = /\bhttp\s*\{/.exec(content);
    if (!httpMatch) return { ok: false, detail: '主配置里找不到 http {} 块，请手工添加 include' };

    const insertAt = httpMatch.index + httpMatch[0].length;
    const line = `\n    ${check.snippet}`;
    const updated = `${content.slice(0, insertAt)}${line}${content.slice(insertAt)}`;
    fs.writeFileSync(mainConf, updated, 'utf8');
    return { ok: true, already: false, file: mainConf, snippet: check.snippet };
  }

  /* ---------- TCP/UDP 转发（stream 模块） ---------- */

  get streamDir() {
    return this.config.streamDir || '';
  }

  /**
   * stream 模块是否可用。
   * 动态编译（Debian/Ubuntu 的 --with-stream=dynamic）需要装包并在主配置里 load_module，
   * 只看 `nginx -V` 会误判，所以这里把「编译进去 / 模块文件在 / 已 load_module」分开判断。
   */
  async streamSupport() {
    if (!this.installed) return { known: true, ok: false, detail: 'nginx 未安装' };
    const result = await run(this.bin, ['-V']);
    const text = `${result.stderr}${result.stdout}`;
    if (!/configure arguments|--with-/.test(text)) {
      return { known: false, ok: true, detail: '无法从 nginx -V 判断 stream 模块，交给 nginx -t 校验' };
    }
    const dynamic = /--with-stream=dynamic/.test(text);
    const compiled = dynamic || /--with-stream(\s|$)/.test(text);
    const modulesPath = (/--modules-path=(\S+)/.exec(text) || [])[1] || '/usr/lib/nginx/modules';
    const moduleFile = dynamic ? path.join(modulesPath, 'ngx_stream_module.so') : null;
    const moduleFileExists = moduleFile ? fs.existsSync(moduleFile) : true;
    const loaded = dynamic ? this.loadsModule('ngx_stream_module.so') : true;
    const ok = compiled && moduleFileExists && loaded;
    return {
      known: true,
      ok,
      compiled,
      dynamic,
      modulesPath,
      moduleFile,
      moduleFileExists,
      loaded,
      hint: ok ? null : streamInstallHint(this.platform, { dynamic, moduleFileExists, loaded }),
      detail: ok
        ? (dynamic ? 'stream 模块已编译并加载' : 'stream 模块已编译进 nginx')
        : `${!compiled ? 'nginx 未编译 stream 模块' : !moduleFileExists ? `缺少动态模块文件 ${moduleFile}` : '主配置没有 load_module ngx_stream_module.so'}`,
    };
  }

  /** 主配置（含顶层 include 的文件）里是否加载了某个动态模块。 */
  loadsModule(name) {
    const files = [this.config.mainConf, ...this.topLevelIncludePatterns().flatMap((pattern) => [
      ...expandGlob(path.dirname(pattern), path.basename(pattern)),
      pattern,
    ])];
    for (const file of files) {
      if (!file || !file.endsWith('.conf')) continue;
      try {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(name)) return true;
      } catch {
        /* 读不了就跳过 */
      }
    }
    return false;
  }

  topLevelIncludePatterns() {
    const mainConf = this.config.mainConf;
    if (!mainConf) return [];
    return parseTopLevelIncludes(mainConf);
  }

  /**
   * 转发目录 include 的状态。
   * 只认「顶层 stream {} 块里」的 include：
   * - 写在顶层作用域（块外）时，里面的 server 块会挂到错误的作用域；
   * - 写在 http {} 里更是直接报错（stream 块不能在 http 里）。
   */
  checkStreamInclude() {
    const mainConf = this.config.mainConf;
    const snippet = `include ${this.streamDir}/*.conf;`;
    if (!mainConf || !fs.existsSync(mainConf)) {
      return {
        ok: false,
        mode: 'missing',
        reason: `主配置不存在: ${mainConf || '(未配置)'}`,
        snippet,
        streamDir: this.streamDir,
        includes: [],
      };
    }
    const scan = scanConf(readText(mainConf));
    const matches = (entry) => {
      const dir = globDir(entry.pattern, mainConf);
      return dir ? coversDir(dir, this.streamDir) : false;
    };
    const inBlock = scan.streamIncludes.filter(matches);
    const atTop = scan.topLevelIncludes.filter(matches);
    const base = {
      mainConf,
      streamDir: this.streamDir,
      snippet,
      includes: [...inBlock, ...atTop].map((entry) => entry.pattern),
      hasStreamBlock: scan.hasStreamBlock,
      topLevel: atTop.map((entry) => entry.pattern),
    };
    if (inBlock.length) {
      return { ok: true, mode: 'stream-block', reason: `已在顶层 stream {} 块里 include ${this.streamDir}`, ...base };
    }
    if (atTop.length) {
      return {
        ok: false,
        mode: 'top-level',
        reason: `${this.streamDir} 的 include 写在顶层作用域（不在 stream {} 块里），里面的 server 块不会生效`,
        ...base,
      };
    }
    return { ok: false, mode: 'missing', reason: `主配置里没有 include ${this.streamDir} 的 stream {} 块`, ...base };
  }

  /**
   * 计算「把转发目录 include 放进顶层 stream {} 块」之后的主配置内容（纯文本变换，不落盘）。
   * - 已经正确时返回 changed=false；
   * - 顶层残留的那份 include（含之前的注释标记）会删掉，避免同一目录被加载两次；
   * - 主配置里已有 stream {} 块就复用（多个规则共用一个块），没有才新建。
   */
  streamIncludeEdit() {
    const mainConf = this.config.mainConf;
    if (!mainConf || !fs.existsSync(mainConf)) {
      return { ok: false, detail: `主配置不存在: ${mainConf || '(未配置)'}` };
    }
    const check = this.checkStreamInclude();
    const content = readText(mainConf);
    if (check.ok) {
      return { ok: true, changed: false, mode: check.mode, file: mainConf, content, snippet: check.snippet };
    }

    const scan = scanConf(content);
    const edits = [];
    for (const entry of scan.topLevelIncludes) {
      const dir = globDir(entry.pattern, mainConf);
      if (!dir || !coversDir(dir, this.streamDir)) continue;
      let start = entry.start;
      const lineStart = content.lastIndexOf('\n', entry.start - 1) + 1;
      if (lineStart > 1) {
        const prevStart = content.lastIndexOf('\n', lineStart - 2) + 1;
        if (/^#\s*fanproxy[:：]/.test(content.slice(prevStart, lineStart - 1).trim())) start = prevStart;
      }
      let end = entry.end;
      if (content[end] === '\n') end += 1;
      edits.push({ start, end, text: '' });
    }
    if (scan.streamBlock) {
      const at = scan.streamBlock.start + 1;
      edits.push({ start: at, end: at, text: `\n    ${check.snippet}` });
    } else {
      edits.push({
        start: content.length,
        end: content.length,
        text: `\n\n# fanproxy: TCP/UDP 转发（stream 模块）\nstream {\n    ${check.snippet}\n}\n`,
      });
    }

    let updated = content;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
    }
    return {
      ok: true,
      changed: true,
      mode: scan.streamBlock ? 'stream-block' : 'created-block',
      file: mainConf,
      content: updated,
      previous: content,
      snippet: check.snippet,
    };
  }

  /** 覆盖写主配置（写坏由调用方还原）。 */
  writeMainConf(content) {
    if (!this.config.mainConf || content === null || content === undefined) return false;
    fs.writeFileSync(this.config.mainConf, content, 'utf8');
    return true;
  }

  /** 还原主配置（addInclude 校验失败时使用）。 */
  restoreMainConf(content) {
    if (!this.config.mainConf || content === null) return false;
    fs.writeFileSync(this.config.mainConf, content, 'utf8');
    return true;
  }
}

/**
 * 解析主配置里「顶层作用域」的 include（http {} / stream {} 块内的不算）。
 */
function parseTopLevelIncludes(file) {
  return scanConf(readText(file)).topLevelIncludes.map((entry) => entry.pattern);
}

/**
 * 扫描 nginx 配置的括号结构，返回：
 * - topLevelIncludes：顶层作用域的 include（http {} / stream {} 里的不算）
 * - streamBlock：顶层 stream {} 块的位置（只有存在时才有）
 * - streamIncludes：顶层 stream {} 块里直接写的 include
 * 注释与引号里的内容会被跳过。
 */
function scanConf(content) {
  const result = { topLevelIncludes: [], streamIncludes: [], streamBlock: null, hasStreamBlock: false };
  let depth = 0;
  let quote = null;
  let index = 0;
  let streamStart = null;
  while (index < content.length) {
    const ch = content[index];
    if (quote) {
      if (ch === '\\') index += 2;
      else {
        if (ch === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (ch === '#') {
      const nl = content.indexOf('\n', index);
      index = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; index += 1; continue; }
    if (ch === '{') {
      if (depth === 0 && precedingWord(content, index) === 'stream') streamStart = index;
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (streamStart !== null && depth === 0) {
        result.streamBlock = { start: streamStart, end: index };
        streamStart = null;
      }
      index += 1;
      continue;
    }
    if (depth === 0 || (streamStart !== null && depth === 1)) {
      if (/^include\s/.test(content.slice(index, index + 8))) {
        const end = content.indexOf(';', index);
        if (end === -1) break;
        const pattern = content.slice(index + 8, end).trim().replace(/^["']|["']$/g, '');
        const entry = { start: index, end: end + 1, pattern };
        if (depth === 0) result.topLevelIncludes.push(entry);
        else result.streamIncludes.push(entry);
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }
  result.hasStreamBlock = Boolean(result.streamBlock);
  return result;
}

/** 取 `{` 前面那个词（跳过空白），用来判断块名是不是 stream。 */
function precedingWord(content, braceIndex) {
  let i = braceIndex - 1;
  while (i >= 0 && /\s/.test(content[i])) i -= 1;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(content[i])) i -= 1;
  return content.slice(i + 1, end);
}

/** include 通配符解析出来的目录是否覆盖目标目录。 */
function coversDir(dir, streamDir) {
  const target = path.resolve(streamDir || 'stream.d');
  const resolved = path.resolve(dir);
  return resolved === target || target.startsWith(`${resolved}${path.sep}`);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 把 include 的通配符前缀还原成目录路径。 */
function globDir(pattern, mainConf) {
  let text = String(pattern || '').trim();
  if (!text) return null;
  if (!path.isAbsolute(text)) text = path.join(path.dirname(mainConf), text);
  const globIndex = text.search(/[*?[]/);
  if (globIndex === -1) return null;
  return text.slice(0, globIndex).replace(/[/\\]+$/, '') || null;
}

/** 装 stream 模块的提示命令，按发行版包管理器给出。 */
function streamInstallHint(platform, state) {
  const manager = platform?.packageManager || '';
  const pkg = { apt: 'libnginx-mod-stream', dnf: 'nginx-mod-stream', yum: 'nginx-mod-stream', apk: 'nginx-mod-stream', zypper: 'nginx-module-stream', pacman: 'nginx-mod-stream' }[manager];
  if (state.dynamic && !state.moduleFileExists && pkg) {
    const install = { apt: `apt install ${pkg}`, dnf: `dnf install ${pkg}`, yum: `yum install ${pkg}`, apk: `apk add ${pkg}`, zypper: `zypper install ${pkg}`, pacman: `pacman -S ${pkg}` }[manager];
    return `安装 stream 模块: ${install}`;
  }
  if (state.dynamic && state.moduleFileExists && !state.loaded) {
    return '在主配置顶层加一行 load_module modules/ngx_stream_module.so;（Debian/Ubuntu 装完包通常已自动包含 /etc/nginx/modules-enabled/*.conf）';
  }
  return '当前 nginx 没有 stream 模块，需重新编译 nginx（--with-stream）或改用发行版带 stream 的包';
}

function collectIncludes(file, depth = 0, seen = new Set()) {
  if (!file || depth > 3 || seen.has(file)) return [];
  seen.add(file);
  let content;
  try {
    if (!fs.existsSync(file)) return [];
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const dirs = [];
  for (const match of content.matchAll(/^\s*include\s+([^;]+);/gm)) {
    let pattern = match[1].trim().replace(/^["']|["']$/g, '');
    if (!pattern) continue;
    if (!path.isAbsolute(pattern)) pattern = path.join(path.dirname(file), pattern);

    const globIndex = pattern.search(/[*?[]/);
    if (globIndex === -1) {
      // 单个文件的 include（如 mime.types）不覆盖目录，只继续递归解析 .conf
      if (pattern.endsWith('.conf')) dirs.push(...collectIncludes(pattern, depth + 1, seen));
      continue;
    }

    // 只有通配符 include 才代表「加载了某个目录」，glob 前缀本身就是目录
    const dir = pattern.slice(0, globIndex).replace(/[/\\]+$/, '');
    if (!isDirectory(dir)) continue;
    dirs.push(dir);
    for (const child of expandGlob(dir, path.basename(pattern))) {
      if (child.endsWith('.conf')) dirs.push(...collectIncludes(child, depth + 1, seen));
    }
  }
  return dirs;
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function expandGlob(dir, pattern) {
  try {
    if (!fs.existsSync(dir)) return [];
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return fs.readdirSync(dir).filter((name) => regex.test(name)).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** 从 `nginx version: nginx/1.28.2` 之类的文本里取出版本号并比较。 */
function versionAtLeast(text, major, minor, patch) {
  const match = /nginx\/(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  if (!match) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
  const target = [major, minor, patch];
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== target[i]) return parts[i] > target[i];
  }
  return true;
}

function tail(result, max = 600) {
  const text = `${result.stderr || ''}${result.stdout || ''}`.trim() || result.error || '';
  return text.length > max ? text.slice(-max) : text;
}

module.exports = { Nginx, collectIncludes, parseTopLevelIncludes, expandGlob };
