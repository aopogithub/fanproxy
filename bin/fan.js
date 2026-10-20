#!/usr/bin/env node
/*
 * 兼容旧服务单元（ExecStart 仍指向 bin/fan.js）的转发入口。
 * 新部署请直接用 bin/fanproxy.js。
 */
'use strict';

require('./fanproxy.js');
