'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT = 5 * 60 * 1000;

/** 在 PATH 中查找可执行文件，返回绝对路径或 null。 */
function resolveBinary(bin) {
  if (!bin) return null;
  if (bin.includes('/')) {
    return fs.existsSync(bin) && isExecutableSafe(bin) ? bin : null;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isExecutableSafe(bin) {
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行外部命令，不抛异常，统一返回 { ok, code, stdout, stderr, command }。
 */
function run(bin, args = [], options = {}) {
  const command = [bin, ...args].join(' ');
  return new Promise((resolve) => {
    execFile(
      bin,
      args.map(String),
      { timeout: DEFAULT_TIMEOUT, maxBuffer: 8 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, code: 0, command, stdout, stderr });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : error.code === 'ENOENT' ? 127 : 1;
        resolve({
          ok: false,
          code,
          command,
          stdout: stdout || '',
          stderr: stderr || '',
          error: error.message,
        });
      },
    );
  });
}

module.exports = { run, resolveBinary };
