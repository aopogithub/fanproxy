#!/usr/bin/env node
/*
 * fanproxy 启动入口（版本守卫）。
 *
 * 本文件必须保持 ES5 语法：低版本 Node 也要能解析出下面这段友好报错，
 * 而不是直接抛 SyntaxError。真正的代码在 ../src/index.js。
 */
'use strict';

var MIN_MAJOR = 16;

(function () {
  var raw = (process.versions && process.versions.node) || '0.0.0';
  var major = parseInt(String(raw).split('.')[0], 10) || 0;

  if (major >= MIN_MAJOR) {
    var args = process.argv.slice(2);
    if (args[0] === 'doctor' || args[0] === 'check') {
      // 自检也要能报错，不能让 Promise 拒绝把进程带成未捕获异常
      require('../src/cli/doctor.js').runDoctor().then(function (bad) {
        process.exitCode = bad ? 1 : 0;
      }).catch(function (err) {
        process.stderr.write('[fanproxy] 自检执行失败: ' + (err && err.stack ? err.stack : err) + '\n');
        process.exitCode = 1;
      });
      return;
    }
    if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
      printHelp();
      return;
    }
    require('../src/index.js').run();
    return;
  }

  printTooOld(raw);
  process.exit(1);
})();

function printHelp() {
  process.stdout.write([
    '',
    '用法:',
    '  fanproxy              启动管理面板（等价于 npm start）',
    '  fanproxy doctor       自检：nginx / certbot / ACME 链路 / 防火墙 / SELinux 一次查完',
    '',
    '环境变量: FAN_CONFIG 指定配置文件，FAN_HOST / FAN_PORT 覆盖监听地址，详见 README。',
    '',
  ].join('\n') + '\n');
}

function printTooOld(raw) {
  var out = [
    '',
    '[fanproxy] Node.js 版本过低：当前 v' + raw + '，需要 Node.js >= ' + MIN_MAJOR + '.0.0',
    '',
    'CentOS / RHEL 7 等老系统（glibc 2.17）常见做法：',
    '  1) 官方 Node 16.20.2 是最后一代支持 glibc 2.17 的版本，可直接用：',
    '       curl -fsSL https://nodejs.org/dist/v16.20.2/node-v16.20.2-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1',
    '  2) 想在老系统上跑 Node 18/20/22，用非官方 glibc-217 构建：',
    '       https://unofficial-builds.nodejs.org/download/release/',
    '  3) nvm 源码编译：nvm install 20 -s（需要 gcc / devtoolset）',
    '  4) 或把面板放进容器运行，挂载宿主机的 /etc/nginx、/etc/letsencrypt、/var/log/nginx',
    '',
  ];

  var glibc = detectGlibc();
  if (glibc) out.push('检测到 glibc: ' + glibc + '（官方 Node 18+ 需要 glibc >= 2.28）');
  out.push('Node 16 已停止维护，条件允许时建议把系统升级到较新的发行版。', '');
  process.stderr.write(out.join('\n') + '\n');
}

function detectGlibc() {
  try {
    if (process.report && typeof process.report.getReport === 'function') {
      var report = process.report.getReport();
      var header = report && report.header;
      if (header && header.glibcVersionRuntime) return String(header.glibcVersionRuntime);
    }
  } catch (err) {
    /* 忽略：只是给报错补充信息 */
  }
  return '';
}
