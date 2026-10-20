#!/usr/bin/env node
'use strict';

/**
 * 版本下限检查：扫描仓库里用到的 Node API，算出真实需要的最低版本，
 * 并与 package.json 的 engines.node 对比，避免无意间把下限抬高
 * （例如用了 Node 18+ 才有的 fetch / Array.at，却在 CentOS 7 上跑 Node 16）。
 *
 * 用法：node scripts/node-compat.js  （npm run compat）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// 浏览器端代码不参与 Node 版本判定
const SKIP_DIRS = new Set(['node_modules', '.git', 'web']);

// API -> 引入版本。顺序无关，脚本取最大值。
const RULES = [
  { name: 'require("node:...") 前缀', pattern: /require\(\s*['"]node:/, min: '14.18.0' },
  { name: 'crypto.randomUUID', pattern: /randomUUID\(/, min: '14.17.0' },
  { name: 'fs.rmSync', pattern: /\brmSync\(/, min: '14.14.0' },
  { name: 'fs.cpSync', pattern: /\bcpSync\(/, min: '16.7.0' },
  { name: '可选链 / 空值合并 (?. ??)', pattern: /\?\.|\?\?/, min: '14.0.0' },
  { name: 'String.replaceAll', pattern: /\.replaceAll\(/, min: '15.0.0' },
  { name: 'String.matchAll', pattern: /\.matchAll\(/, min: '12.0.0' },
  { name: 'Object.fromEntries', pattern: /Object\.fromEntries\(/, min: '12.0.0' },
  { name: 'Array.flat / flatMap', pattern: /\.flatMap\(|\.flat\(/, min: '11.0.0' },
  { name: 'Array.at（负索引）', pattern: /\.at\(-?\d/, min: '16.6.0' },
  { name: 'Object.hasOwn', pattern: /Object\.hasOwn\(/, min: '16.9.0' },
  { name: 'Object.groupBy / Map.groupBy', pattern: /\.groupBy\(/, min: '21.0.0' },
  { name: 'Array.findLast', pattern: /findLast(Index)?\(/, min: '18.0.0' },
  { name: 'Array.prototype.toSorted/toReversed/with', pattern: /\.toSorted\(|\.toReversed\(|\.with\(/, min: '20.0.0' },
  { name: 'structuredClone', pattern: /structuredClone\(/, min: '17.0.0' },
  { name: 'AbortSignal.timeout', pattern: /AbortSignal\.timeout\(/, min: '17.3.0' },
  { name: 'global fetch', pattern: /[^.\w]fetch\(/, min: '18.0.0' },
  { name: 'Array.fromAsync', pattern: /Array\.fromAsync\(/, min: '22.0.0' },
  { name: 'fs.mkdirSync({recursive})', pattern: /mkdirSync\([^)]*recursive/, min: '10.12.0' },
  { name: 'crypto.scryptSync', pattern: /scryptSync\(/, min: '10.5.0' },
  { name: 'Buffer.from', pattern: /Buffer\.from\(/, min: '5.10.0' },
];

const SCRIPT_RULES = [
  { name: 'node --watch（仅 npm run dev:watch 需要）', pattern: /--watch/, min: '18.11.0', optional: true },
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

function compare(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function scan() {
  const hits = new Map();
  for (const file of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file);
    const content = fs.readFileSync(file, 'utf8');
    for (const rule of RULES) {
      if (!rule.pattern.test(content)) continue;
      if (!hits.has(rule.name)) hits.set(rule.name, { rule, files: [] });
      hits.get(rule.name).files.push(rel);
    }
  }

  const scripts = readScripts();
  const scriptHits = [];
  for (const rule of SCRIPT_RULES) {
    if (!rule.pattern.test(scripts.raw)) continue;
    scriptHits.push({ rule, commands: scripts.commands.filter((cmd) => rule.pattern.test(cmd)) });
  }

  const found = [...hits.values()];
  const required = found.reduce((max, item) => (compare(item.rule.min, max) > 0 ? item.rule.min : max), '0.0.0');
  return { found, scriptHits, required };
}

function readScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const commands = Object.values(pkg.scripts || {});
  return { commands, raw: commands.join('\n') };
}

function declaredFloor() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const range = String((pkg.engines || {}).node || '').replace(/\s/g, '');
  const match = /^>=?(\d+(\.\d+){0,2})$/.exec(range);
  return match ? match[1] : null;
}

(function main() {
  const { found, scriptHits, required } = scan();
  const declared = declaredFloor();

  console.log('使用的 Node API 与所需版本：');
  if (!found.length) console.log('  （无）');
  for (const item of [...found].sort((a, b) => compare(a.rule.min, b.rule.min))) {
    console.log(`  ${String(item.rule.min).padEnd(8)} ${item.rule.name}  ← ${item.files.join(', ')}`);
  }
  for (const item of scriptHits) {
    console.log(`  ${String(item.rule.min).padEnd(8)} ${item.rule.name}${item.rule.optional ? '（可选脚本，不影响运行下限）' : ''}  ← ${item.commands.join(' ; ')}`);
  }

  console.log(`\n代码实际最低要求： Node >= ${required}`);
  console.log(`package.json 声明： ${declared ? `Node >= ${declared}` : '(未声明)'}${declared && declaredFloor() !== declared ? '' : ''}`);

  let failed = false;
  if (declared && compare(required, declared) > 0) {
    console.error(`\n✗ 代码需要 Node >= ${required}，但声明的是 >= ${declared}，在声明的版本上会崩。`);
    failed = true;
  } else if (declared) {
    console.log(`✓ 声明下限 ${declared} 覆盖了代码实际需求。`);
  }

  const hardScripts = scriptHits.filter((item) => !item.rule.optional);
  const scriptRequired = hardScripts.reduce((max, item) => (compare(item.rule.min, max) > 0 ? item.rule.min : max), '0.0.0');
  if (declared && compare(scriptRequired, declared) > 0) {
    console.error(`✗ 强制脚本需要 Node >= ${scriptRequired}，高于声明下限。`);
    failed = true;
  }

  process.exit(failed ? 1 : 0);
})();
