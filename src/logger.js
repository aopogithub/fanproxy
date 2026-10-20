'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (name, stream) => (...args) => {
    if (LEVELS[name] < threshold) return;
    const line = `${new Date().toISOString()} [${name.toUpperCase()}]`;
    stream.write(`${[line, ...args.map(format)].join(' ')}\n`);
  };

  return {
    level,
    debug: emit('debug', process.stdout),
    info: emit('info', process.stdout),
    warn: emit('warn', process.stderr),
    error: emit('error', process.stderr),
  };
}

function format(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = { createLogger };
