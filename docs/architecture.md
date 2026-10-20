# 架构说明

## 目标

把 nginx 当作被管理的执行引擎：面板是唯一写入口，所有变更都走「渲染配置 → `nginx -t` → `nginx -s reload`」，
校验失败立即回滚，避免把 nginx 配崩。证书由 certbot 的 webroot 模式签发，并周期性自动续期。

## 分层

```
bin/fanproxy.js           启动入口：ES5 版本守卫，版本不足时打印升级指引
scripts/node-compat.js  扫描源码里的 Node API，校验版本下限
src/web/             纯静态面板（原生 JS，五个标签页）
src/http/server.js   HTTP 服务、路由、鉴权中间件、静态资源
src/http/api.js      路由处理器，只做参数整理与编排调用
src/core/manager.js  编排：applySite / issueCertificate / renewCertificates / restoreSnapshot / healthCheck
src/core/nginx.js    nginx 命令封装：-t、-s reload、include 检查
src/core/certbot.js  certbot 命令封装：certonly、renew、certificates
src/core/protocol.js  上游协议白名单与 gRPC 判定（store / renderer / 健康探测共用）
src/core/streamstore.js TCP/UDP 转发规则模型与持久化（data/streams.json，端口冲突检测）
src/core/renderer.js 站点模型 → nginx 配置文本（每个站点一个 conf，文件名/路径/托管标记也在这里定义；gRPC 站点输出 grpc_pass 并按 nginx 版本选择 http2 指令）
src/core/backup.js   配置快照：sites.json 与各站点 conf 的版本记录、回滚、按份数裁剪（手动快照永久保留，不参与裁剪）
src/core/logs.js     访问日志尾部读取与聚合（状态码、流量、Top URL/IP/UA、时间线）
src/core/auth.js     scrypt 密码、内存会话、失败锁定、用户文件 data/users.json
src/core/hostutil.js IPv6 上游地址的方括号 / Host 头转换（渲染与健康探测共用）
src/core/platform.js 发行版识别：nginx 路径、日志目录、运行用户、reload 策略、包管理器
src/core/scheduler.js 自动续期调度
src/core/settings.js 面板可写设置（data/settings.json）：目前只有健康检查参数
src/core/healthcheck.js 单次上游探测：TCP 连通性 + 可选 HTTP 状态
src/core/healthmonitor.js 主动健康检查：定时探测所有启用站点，保留近 10 次结果到 data/health.json
src/store.js         站点状态持久化（data/sites.json，原子写入）
src/config.js        配置加载：默认值 < config.json < 环境变量
```

## 数据流

1. 面板提交站点 → `store` 在写入前触发 `beforeChange` 钩子 → `backup` 记录 `sites.json` 快照 → 落盘（期望状态）。
2. `manager.applySite` 先把旧的 `<sitesDir>/<域名>.conf` 存成快照，再调 `renderer.render` 写新配置。
   每个站点一个文件（默认 `fanproxy-<首个域名>.conf`，写在 `/etc/nginx/conf.d`），文件名在创建站点时分配并持久化在 `confFile` 字段。
   `httpEnabled: false` 的站点（面板里的「关闭 HTTP」）只生成 443 的 server 块；该开关仅在 `ssl.enabled` 为真时生效，签发与续期都会临时放通 80 端口。
3. `nginx -t` 通过则 `nginx -s reload`；不通过则还原上一版本文件。
4. 申请证书：保存站点时若 `ssl.enabled=true` 但没有证书路径，`api.createSite/updateSite` 会先把站点按 HTTP 落库，
   再交给 `manager.ensureHttps`：先确保 80 端口站点生效（webroot 校验需要），再 `certbot certonly --webroot`；
   成功后写回 `ssl.certPath/keyPath` 并重新 apply（生成 443 站点 + 80 跳转）。
   live 目录下已有同域名证书时跳过签发直接复用；签发失败则站点保持 HTTP 运行，响应里的 `issued` 会带上失败步骤。
5. `scheduler` 按 `scheduler.intervalMinutes` 触发 `certbot renew`，`--deploy-hook` 负责 reload nginx。
6. 日志：每个站点生成独立的 `access_log` / `error_log`，`core/logs.js` 只读尾部 N MB，避免大文件拖垮面板。
7. 快照：`applySite`/`setupInclude` 等改动前自动生成快照，`Backup.prune()` 只裁剪自动快照、保留最近 `backup.keep` 份；
   面板里手动创建的快照带 `manual` 标记，永久保留、不计入上限（`POST /api/backups`），列表响应里带 `counts` 方便展示。
8. 回滚：`POST /api/backups/:id/restore` 覆盖文件后重新 `nginx -t` + reload，并重新载入站点列表。
9. 主动健康检查：`healthMonitor` 按 `healthcheck.intervalSeconds` 并发探测所有启用站点的上游（TCP，站点级 `advanced.healthCheckPath` 或全局 `healthcheck.path` 决定是否追加 HTTP 探测），
   每站点保留最近 20 条结果写入 `data/health.json`；`GET /api/sites`、`GET /api/status` 把历史带给面板，站点列表渲染成 20 个竖条，前端默认每 10 秒只替换竖条 DOM（局部刷新，不动表单）。参数可在「设置 → 健康检查」里改（`PUT /api/settings/healthcheck`），保存后定时器立即按新间隔重建。
10. TCP/UDP 转发：规则存在 `data/streams.json`，`manager.applyStream` 渲染裸 `server { listen ...; proxy_pass ...; }` 写进 `nginx.streamDir`（默认与站点目录同级），
    复用与站点相同的「快照 → 写文件 → `nginx -t` → reload → 失败回滚」流程。nginx 只允许一个顶层 `stream {}` 块，所以全局只由主配置写一次 `stream { include <streamDir>/*.conf; }`：
    `nginx.checkStreamInclude()` / `scanConf()` 用括号深度扫描区分「顶层 include」「`stream {}` 块里的 include」和「`http {}` 里的 include」，`manager.setupStreamInclude()` 负责把 include 放进块里
    （已有块就复用；误写在顶层的残留会被删掉，避免目录被加载两次）、把旧版「每条规则自带 `stream {}` 包装」的文件刷成裸 `server` 块，并自动备份、`nginx -t`、失败整体还原。
    `applyStream` 与面板启动时都会调用它（幂等），目录为空时自动补一个占位 conf，避免 `include dir/*.conf;` 匹配不到文件导致 `nginx -t` 失败。
11. 清理：`manager.sweep()` 扫描配置目录，删除「带 `# 由 fanproxy 自动生成` 标记但不属于任何启用站点」的 `.conf`；启动时自动执行，也可通过 `POST /api/sites/prune` 手动触发。三处删除逻辑（停用、改域名、sweep）都只碰带标记的文件。

## 鉴权模型

- 会话：`POST /api/auth/login` 校验 scrypt 密码，成功后下发 `fanproxy_session` HttpOnly cookie；会话存内存，重启失效。
- 令牌：`panel.authToken` 仍可用，适合脚本/CI 调用，走 `x-fanproxy-token`（旧头 `x-fan-token` 仍兼容）或 `Bearer`。
- 开放模式：既没有用户也没有 token 时，面板无鉴权（仅建议本机调试），启动会打印告警。
- 防护：同 IP 连续 5 次登录失败锁定 5 分钟；cookie 在 `X-Forwarded-Proto: https` 下自动加 `Secure`。

## TCP/UDP 转发模型

见 `src/core/streamstore.js` 的 `STREAM_DEFAULTS`：协议（tcp/udp）、监听地址与端口、后端地址与端口、
连接超时、空闲超时（`proxy_timeout`）。校验会拒绝同协议 + 同地址 + 同端口的冲突规则。
与站点（7 层）不同，转发是 4 层透传：不终止 TLS、不解析内容、不做健康检查，也不参与证书签发。

## 站点模型

见 `src/store.js` 的 `SITE_DEFAULTS`：域名列表、HTTP/HTTPS 端口、上游协议（`http`/`https`/`grpc`/`grpcs`，见 `src/core/protocol.js`）/地址/端口、WebSocket、
证书与续期开关、请求体上限、附加 header、附加 location 片段、健康检查路径、自定义日志路径。

## 跨发行版适配

`src/core/platform.js` 是唯一的平台探测点，`config.js` 用它生成默认值（用户显式配置与环境变量优先）：

- **发行版识别**：读 `/etc/os-release` 的 `ID` / `ID_LIKE`，兜底检查 `/etc/alpine-release`；macOS / FreeBSD 直接看 `process.platform`。
- **路径默认值**：主配置候选（`/etc/nginx` 或 `/usr/local/etc/nginx`）、站点目录（`conf.d` / `http.d` / `servers`）、日志目录、certbot webroot。
- **运行用户**：Debian 系 `www-data`，RHEL 系与 Alpine 是 `nginx`，Arch 是 `http`，FreeBSD 是 `www`；以 root 运行时会把 `logDir/fanproxy` 的属主改成它。
- **reload 策略**：先 `nginx -s reload`，失败按 systemd / OpenRC / sysv 依次回退，返回值里带每一步的结果，便于面板展示。
- **include 检测**：解析主配置的 `include` 指令（递归一层），只有通配符 include 才视为「加载了某个目录」，因此 Alpine 的 `http.d`、Debian 的 `sites-enabled` 都能正确判断。
- **一键接入**：`manager.setupInclude()` 先给主配置打快照，再把 include 插进 `http {}` 块首行，`nginx -t` 通过才 reload，失败立刻还原原文。

### 版本下限

入口故意放在 `bin/fanproxy.js` 并用 ES5 语法：低版本 Node 也能解析出「版本过低」的友好提示，而不是 `SyntaxError`。
真正的下限由 `scripts/node-compat.js` 静态扫描得出（当前是 14.18，来自 `require('node:...')` 前缀），
声明值取 16 —— 因为 16 是官方最后一代提供 glibc 2.17 构建的版本，正好覆盖 CentOS / RHEL 7。
新增依赖新 API 的代码时跑一次 `npm run compat` 即可发现下限漂移。

## 前端设计系统

`src/web/` 遵循仓库根目录 `DESIGN.md`（PlayStation 设计系统分析）：

- 三画布章节：白 `canvas-light` 承载工具界面，黑 `canvas-dark` 用于主/子导航、日志章节与页脚，蓝 `primary #0070d1` 只用于主 CTA、状态徽标与页脚带。
- 字阶：页头 `display-lg`（44/300），区块标题 `heading-lg`（22/300），正文 `body-md`（18/400），标签 `caption-sm`（12/500）。
- 形状：CTA 一律胶囊 `rounded.full`（48px 高），卡片 `rounded.md`（8px），输入框 `rounded.sm`（4px），焦点态用 2px `primary` 描边而非外发光。
- 不用阴影、不用渐变；章节分隔靠背景色切换。
- 专有字体 PlayStation SST 以系统无衬线 + weight 300 近似替代。
- 响应式断点沿用 1024 / 768，栅格在窄屏塌缩为单列，主内容最大宽度 1280px。

## 安全边界

- 面板默认只监听 `127.0.0.1`；对外开放时必须启用账号或 token，并前置 TLS。
- 面板需要以 root（或有 sudo 权限）运行，因为它要写 nginx 配置目录并 reload。
- `extraLocations` 会原样写入 nginx 配置，等于把配置能力开放给能访问面板的人，务必限制访问来源。
