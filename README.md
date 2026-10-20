# fanproxy

反向代理管理面板：对 nginx 做二次封装，用 Web 界面管理站点，并用 certbot 完成证书签发与自动续期。

## 特性

- 站点即配置：每个代理在 nginx 配置目录（默认 `/etc/nginx/conf.d`）里单独持有一个 conf 文件，如 `fanproxy-blog.example.com.conf`
- 配置可辨认：文件带 `# 由 fanproxy 自动生成` 标记，fanproxy 只覆盖/清理自己生成的文件，不动手写配置
- 变更安全：写入前 `nginx -t` 校验，失败自动回滚；每次变更留配置快照，可一键回滚。备份页把手动快照与自动快照分开显示：自动快照只保留最近 `backup.keep` 份，手动创建的快照永久保留、不计入该上限
- 证书自动化：勾选「启用 HTTPS」保存即自动签发（本地已有证书直接复用）；certbot webroot 模式，80 端口自动放通 ACME challenge，签发后自动切换 HTTPS 并生成跳转
- 仅 HTTPS：可勾选「关闭 HTTP」，站点不再监听 80 端口，只保留 HTTPS 访问（需要先启用 HTTPS）
- 自动续期：内置调度器周期执行 `certbot renew`，`--deploy-hook` 负责 reload nginx；「仅 HTTPS」站点会在续期时临时放通 80 端口做 ACME 校验，续期完立刻撤掉
- 面板账号：scrypt 密码 + 会话 cookie，登录失败次数过多自动锁定；仍保留 API token 供脚本调用
- 日志统计：按站点独立 access_log，面板查看请求量、流量、状态码分布、Top URL/IP/UA（默认 top3，可点「更多」展开到 20 条）
- 主动健康检查：按可配置的间隔主动探测每个启用站点的上游（TCP，填了路径再加一次 HTTP 探测），站点列表里用 20 个竖条展示最近 20 次结果（绿=成功、红=失败、灰=暂无数据），竖条可定时局部自动刷新（列表上方开关，默认每 10 秒），历史持久化到 `data/health.json`
- gRPC 代理：上游协议可选 `grpc`（明文 h2c）或 `grpcs`（TLS），面板生成 `grpc_pass` + `grpc_set_header`，并为 gRPC 站点自动开启 HTTP/2（按 nginx 版本选 `http2 on;` 或 `listen ... http2`）；gRPC 站点的健康探测只做 TCP，避免用 HTTP/1.1 探测造成误报
- TCP/UDP 转发：4 层转发（nginx `stream` 模块），一条规则 = 一个监听端口 → 后端地址端口，整条连接原样透传（不改证书、不看内容），适合非 HTTP 协议或客户端要校验后端证书的场景；面板会检测 nginx 是否带 `stream` 模块并给出安装命令，也会把转发目录的 include 写进主配置的 `stream {}` 块（自动迁移旧格式）
- IPv6 上游：`[::1]` 与 `::1` 两种写法都能识别，`proxy_pass` 会补方括号、健康探测与 HTTP `Host` 头按 IPv6 规则处理；域名同时解析出 A/AAAA 时自动回退可用地址
- 跨发行版：自动识别 Debian/Ubuntu、RHEL/CentOS/Fedora、Alpine、openSUSE、Arch、FreeBSD、macOS 的 nginx 主配置、站点目录、日志目录与 reload 方式
- 一键接入：主配置没 include 站点目录时，可在面板里一键写入（自动备份 + `nginx -t` 校验，失败自动还原）
- 零依赖：只用 Node 内置模块，无需 npm install，前端无构建步骤

## 快速开始

```bash
cp config.example.json config.json   # 按需修改 nginx/certbot 路径
FAN_ADMIN_PASSWORD='改成你的密码' npm start   # 首次启动创建管理员账号
```

默认面板地址 `http://127.0.0.1:8787`。

前置条件：

- Node.js >= 16（代码实际最低 14.18；16 是最后一代官方支持 glibc 2.17 的版本，所以能覆盖 CentOS 7）
- 已安装 nginx 与 certbot
- nginx 主配置的 `http {}` 中包含站点目录（如 `include /etc/nginx/conf.d/*.conf;`）；没有也没关系，面板「设置 → nginx 接入」可一键写入

### 运行环境与版本下限

`package.json` 里声明的 `node >= 16` 是**支持下限**，不是代码硬需求：`npm run compat` 会扫描源码用到的 Node API，
算出真实最低版本（当前 **14.18**，由 `require('node:...')` 前缀决定）并与声明值比对，防止无意间把下限抬高。

| Node 版本 | 说明 |
| --- | --- |
| 14.18 – 15 | 能跑通，但不建议（更早 EOL） |
| 16.x | 支持下限；官方最后一代提供 glibc 2.17 构建，CentOS / RHEL 7 可用 |
| 18 / 20 / 22 | 推荐；官方二进制要求 glibc >= 2.28 |

启动入口是 `bin/fanproxy.js`（刻意保持 ES5 语法），版本不足时会打印可读的升级指引，而不是抛 `SyntaxError`。

### 在 CentOS 7 / RHEL 7 上运行

CentOS 7 的 glibc 是 2.17，官方 Node 18 及以上的二进制会直接报 `GLIBC_2.28 not found`。可选方案：

1. **官方 Node 16.20.2**（最省事）
   ```bash
   curl -fsSL https://nodejs.org/dist/v16.20.2/node-v16.20.2-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1
   ```
2. **glibc-217 非官方构建**（想在老系统上用 Node 18/20/22）
   https://unofficial-builds.nodejs.org/download/release/
3. **源码编译**：`nvm install 20 -s`，需要 gcc / devtoolset
4. **容器**：容器内同时装 nginx + certbot，挂载宿主机的 `/etc/nginx`、`/etc/letsencrypt`、`/var/log/nginx`

CentOS 7 默认开启 SELinux，nginx 反向代理上游需要放行：

```bash
setsebool -P httpd_can_network_connect 1
```

`deploy/install.sh` 检测到 SELinux Enforcing 或 glibc < 2.28 时会直接给出提示，版本门槛可用 `MIN_NODE_MAJOR=14` 覆盖。

## 支持的系统

启动时会读取 `/etc/os-release` 判断发行版，自动给出下面的默认值（配置里显式写了就以配置为准）：

| 系统 | 站点目录 | nginx 用户 | 服务管理 |
| --- | --- | --- | --- |
| Debian / Ubuntu / Kali / Mint | `/etc/nginx/conf.d` | `www-data` | systemd |
| RHEL / CentOS / Rocky / Alma / Fedora | `/etc/nginx/conf.d` | `nginx` | systemd |
| Alpine | `/etc/nginx/http.d` | `nginx` | OpenRC |
| openSUSE / SLES | `/etc/nginx/conf.d` | `nginx` | systemd |
| Arch / Manjaro | `/etc/nginx/conf.d` | `http` | systemd |
| FreeBSD | `/usr/local/etc/nginx/conf.d` | `www` | rc.d |
| macOS (Homebrew) | `…/etc/nginx/servers` | 当前用户 | launchd |

`config.json` 里省略 `nginx.mainConf` / `nginx.sitesDir` / `certbot.webroot` 等路径字段即使用自动检测值。
reload 优先用 `nginx -s reload`，失败后回退到 `systemctl reload nginx` / `rc-service nginx reload` / `service nginx reload`。

首次使用：面板默认账号是 **admin / admin**，首次登录会自动跳到「设置」页并提示改密（点「修改我的密码」即可改；也可以稍后再改）。
把 `panel.adminPassword` 显式配置成 `""` 表示不创建账号（面板退回无鉴权模式，仅建议内网/本机使用）；
想用别的初始密码就设 `panel.adminPassword` 或环境变量 `FAN_ADMIN_PASSWORD`，这样首次登录不会强制提示改密。

## 证书签发

- 站点表单勾选「启用 HTTPS」保存即可自动签发：先把站点按 HTTP 生效（ACME webroot 校验需要），
  再执行 `certbot certonly --webroot`，成功后写回 `ssl.certPath/keyPath` 并重新 apply（生成 443 站点 + 80 跳转）。
  `certbot.liveDir/<主域名>/` 下已有证书时直接复用，不重复签发。
- 签发期间按钮会变成「申请中…」并在表单下方显示状态，输出面板逐条打印 nginx 校验、reload 与 certbot 的步骤。
  正常需要 10-60 秒：域名必须解析到本机、外网 80 端口可达；若长时间没有结果，先在服务器上手动执行
  `certbot certonly --webroot -w /var/www/certbot -d 你的域名` 看真实报错。
- 签发失败不影响保存：站点保持 HTTP 运行，接口返回 `issued.ok=false`，面板会提示可点「申请证书」重试。
- **测试证书（staging）**：staging 证书不被浏览器信任（Chrome 会提示不安全），只用来调试。取消勾选「测试证书」保存或点「申请证书」时，
  会带 `--force-renewal` 重新签发生产证书——否则 certbot 认为现有证书还没到期会直接跳过，一直停留在测试证书上。
- 站点取消勾选「启用 HTTPS」并保存时，会自动清空它引用的 certbot 证书路径（自己填的第三方路径不受影响），
  这张证书随即变成「未关联」，可直接在证书页删掉。
- 「证书」标签页会列出每条证书的关联站点：**没有关联站点的证书可以直接删除**（测试证书、换域名后的残留）；
  仍被引用的证书不能删（删了 nginx 配置会指向不存在的文件），需要先在站点里取消启用 HTTPS 或换成其它证书。
- 续期由内置调度器负责（`scheduler.intervalMinutes`，默认 12 小时检查一次），`--deploy-hook` 负责 reload nginx；
  也可以在「证书」标签页手动触发。

### 申请不到证书怎么排查

```bash
node bin/fanproxy.js doctor     # 或 npm run doctor
```

自检会按顺序查：Node/系统 → nginx 二进制、主配置、include、`nginx -t`、站点/日志目录可写 →
certbot 与 webroot → 每个启用站点的 DNS 解析与 **ACME 端到端探测**（在 webroot 放临时文件，再从
`http://域名/.well-known/acme-challenge/<token>` 取回）→ SELinux → firewalld/ufw →
certbot 日志里最后一次 `Arguments:`。每条失败都带 `↳` 修复建议，退出码非 0 表示存在阻塞问题。

手工排查顺序（和自检一致）：

1. **证书到底有没有在签**：`grep -n "Arguments:" /var/log/letsencrypt/letsencrypt.log | tail`。
   只有 `Arguments: []` 说明是手动执行的 certbot，面板请求还没走到签发；看面板日志（`journalctl -u fanproxy -n 60`）
   里的 `执行 certbot: ...` 与 `nginx -t` 步骤定位卡点。
2. **DNS**：`dig +short A 你的域名` 与 `dig +short AAAA 你的域名`。
   A 必须是这台机器的公网 IP；如果 certbot 报 `DNS problem: NXDOMAIN looking up AAAA for ...`，
   说明权威 DNS 对这个名字返回了 NXDOMAIN（= 名字不存在）：要么子域根本没加解析（刚加的要等负缓存 TTL 过期），
   要么解析商对「不存在的 AAAA 类型」错误地回了 NXDOMAIN —— 后者 Let's Encrypt 会直接判定域名不存在而拒绝签发，
   需要给该子域补一条 AAAA 记录，或换用会返回 NOERROR/NODATA 的解析服务商（Cloudflare 等）。
   `fanproxy doctor` 的 DNS 行会把系统解析器、8.8.8.8、1.1.1.1 三种查询的 A/AAAA 结果并排打出来。
3. **80 端口可达**：在外网机器上 `curl -I http://你的域名/.well-known/acme-challenge/`；
   云服务器别忘安全组，本机 `firewall-cmd --add-service=http --permanent && firewall-cmd --reload`。
4. **nginx 是否真的在服务这个域名**：`curl -H 'Host: 你的域名' http://127.0.0.1/`，站点要在面板里保存并生效。
5. **SELinux**：`getenforce`；`ausearch -m avc -ts recent`，必要时 `setsebool -P httpd_can_network_connect 1`。
6. **手动复现面板命令**（会打印真实报错）：
   `certbot certonly --webroot -w /var/www/certbot --agree-tos --non-interactive -d 你的域名 --email 你的邮箱`

## 配置

配置优先级：内置默认值 < `config.json` < 环境变量（`FAN_CONFIG` 指定配置文件路径）。

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `FAN_PORT` / `FAN_HOST` | 面板监听地址 |
| `FAN_TOKEN` | API token（可选，与账号体系并存） |
| `FAN_ADMIN_USER` / `FAN_ADMIN_PASSWORD` | 首次启动创建的管理员账号（默认 `admin` / `admin`） |
| `FAN_SESSION_TTL_HOURS` | 会话有效期，默认 12 小时 |
| `FAN_NGINX_BIN` / `FAN_NGINX_MAIN_CONF` / `FAN_NGINX_SITES_DIR` / `FAN_NGINX_STREAM_DIR` / `FAN_NGINX_FILE_PREFIX` / `FAN_NGINX_LOG_DIR` | nginx 相关路径（站点目录与 TCP 转发目录）与配置文件名前缀 |
| `FAN_CERTBOT_BIN` / `FAN_CERTBOT_WEBROOT` / `FAN_CERTBOT_LIVE_DIR` / `FAN_CERTBOT_EMAIL` | certbot 相关路径 |
| `FAN_CERTBOT_TIMEOUT_MS` | certbot 单次执行超时，默认 300000（5 分钟）；超时会作为失败返回 |
| `FAN_BACKUP_ENABLED` / `FAN_BACKUP_DIR` / `FAN_BACKUP_KEEP` | 配置快照开关、目录与自动快照保留份数（手动快照不受该上限约束，永久保留） |
| `FAN_LOGS_MAX_BYTES` | 单次日志分析读取的尾部字节数 |
| `FAN_SCHEDULER_ENABLED` | 是否启用自动续期调度 |
| `FAN_HEALTHCHECK_ENABLED` / `FAN_HEALTHCHECK_INTERVAL` / `FAN_HEALTHCHECK_TIMEOUT` / `FAN_HEALTHCHECK_PATH` | 主动健康检查开关、间隔（秒）、超时（毫秒）、默认探测路径 |

> 环境变量与配置文件里的 `fan_*` 字段名沿用历史命名（`FAN_*` 前缀、`fan_session` cookie），改名后没有动，避免破坏已有服务单元与脚本。

## API

所有 `/api/*` 接口都需要鉴权（`/api/health`、`/api/auth/login`、`/api/auth/me` 除外），
支持会话 cookie，或 `x-fanproxy-token`（旧头 `x-fan-token` 兼容）/ `Authorization: Bearer` 两种 token 方式。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 账号密码登录，返回会话 cookie |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 当前登录状态 |
| POST | `/api/auth/password` | 修改自己的密码 |
| GET/POST | `/api/auth/users` | 列出 / 新增账号（重置密码） |
| DELETE | `/api/auth/users/:username` | 删除账号 |
| GET | `/api/status` | nginx/certbot 版本、include 检查、系统信息、站点（含健康历史）与路径概览 |
| GET/PUT | `/api/settings/healthcheck` | 读取 / 修改主动健康检查参数（`enabled`、`intervalSeconds`、`timeoutMs`、`path`） |
| GET | `/api/platform` | 发行版、初始化系统、包管理器、安装依赖命令 |
| POST | `/api/setup/include` | 把站点目录 include 写入 nginx 主配置（备份 + 校验 + 失败还原） |
| GET | `/api/sites` | 站点列表（每项带 `health` 最近一次结果与 `history` 近 10 次结果） |
| POST | `/api/sites` | 新建站点（默认立即 apply；勾选 HTTPS 且未填证书路径时自动签发并切换） |
| GET/PUT/DELETE | `/api/sites/:id` | 查询/更新/删除站点（PUT 同样支持自动签发；`apply:false` 只保存不生效） |
| GET | `/api/sites/:id/preview` | 预览渲染出的 nginx 配置 |
| POST | `/api/sites/:id/apply` | 重新生成配置并 reload（可带 `{enabled}` 启停） |
| POST | `/api/sites/:id/certificate` | 申请（或重新申请）证书并切换 HTTPS，可带 `{force:true}` 强制重签 |
| DELETE | `/api/certificates/:name` | 删除证书（仅限未被站点引用的，否则返回 400） |
| POST | `/api/sites/:id/health` | 立即探测单站点上游（TCP / 可选 HTTP），并计入最近 10 次历史 |
| GET | `/api/sites/:id/logs` | 单站点访问日志统计 |
| GET | `/api/sites/:id/errors` | 单站点错误日志尾部 |
| GET | `/api/logs` | 全站（或按 `siteId`）访问日志统计 |
| GET/POST | `/api/streams` | TCP/UDP 转发规则列表（含 stream 模块与 include 状态）/ 新建 |
| GET/PUT/DELETE | `/api/streams/:id` | 查询 / 更新 / 删除转发规则 |
| POST | `/api/streams/:id/apply` | 应用或停用转发规则（可带 `{enabled}`） |
| POST | `/api/streams/apply-all` | 批量应用全部转发规则 |
| POST | `/api/setup/stream-include` | 把转发目录 include 写进 nginx 主配置的 `stream {}` 块（幂等，写前快照、失败还原） |
| POST | `/api/sites/apply-all` | 批量重新生成并 reload |
| POST | `/api/sites/prune` | 清理 nginx 目录中失效的 fanproxy 托管配置 |
| GET | `/api/certificates` | 证书列表与剩余天数 |
| POST | `/api/certificates/renew` | 立即执行一次续期检查 |
| GET/POST | `/api/backups` | 快照列表（带 `manual` 标记与自动/手动计数）/ 手动创建快照（永久保留，不参与自动裁剪） |
| POST | `/api/backups/:id/restore` | 回滚快照（并 reload nginx） |
| DELETE | `/api/backups/:id` | 删除快照 |

## 配置文件的组织方式

每个代理站点在 `nginx.sitesDir`（默认 `/etc/nginx/conf.d`）下拥有一个独立文件：

```
/etc/nginx/conf.d/
├── fanproxy-blog.example.com.conf     # site: 博客 (68541070-...)
├── fanproxy-api.example.com.conf      # site: API 网关 (d397b506-...)
└── default.conf                  # 你自己的配置，fanproxy 不会碰
```

- 文件名由首个域名生成（去掉 `*.` 通配），前缀可配 `nginx.filePrefix`，重名自动加 `-2`
- 文件头带 `# site: <名称> (<id>)`，便于和面板里的站点对应
- 停用站点会删除对应文件；改了域名后旧文件会被自动移除
- 启动时会清理「带 fanproxy 标记但没有对应站点」的孤儿配置，也可以点面板上的「清理失效配置」

TCP/UDP 转发的规则在 `nginx.streamDir`（默认 `/etc/nginx/stream.d`）下，同样一条规则一个文件：

```
/etc/nginx/stream.d/
└── fanproxy-stream-nas-8443.conf      # stream: NAS 设备空间 (7c1f3b9a-...)
```

- 文件里只写裸 `server { ... }` 块，文件头带 `# stream: <名称> (<id>)`。`stream` 是顶层块，全局只允许一个，所以 `stream { include ...; }` 由主配置负责，多个规则共用一个块（每条规则各带一个 `stream {}` 会被 nginx 判定为 `stream directive is duplicate`）
- 主配置里需要有一个 `stream {}` 块 include 该目录（直接改 `nginx.conf` 或在里面 include 的文件都行）：
  ```nginx
  stream {
      include /etc/nginx/stream.d/*.conf;
  }
  ```
  面板「TCP 转发」页会在新建/应用规则时自动写好（已有 `stream {}` 块就复用，不会新建第二个；之前误写在顶层作用域的那份 include 会被挪进去）；也可以点「写入 stream include」手动触发。改动前都会备份主配置，`nginx -t` 失败自动还原
- 目录里没有任何规则时会自动留一个占位 conf：`include` 通配符匹配不到文件会让 `nginx -t` 直接报错，占位文件用来顶住

## 部署

```bash
sudo bash deploy/install.sh              # 自动识别发行版：缺什么装什么 + 部署 + 注册服务
SKIP_DEPS=1 sudo bash deploy/install.sh  # 只部署，不动系统包
```

安装脚本会先探测 `nginx` / `certbot`：都已安装时不做任何包安装（连 `apt-get update` 都不会跑），
只有一个缺失时只装缺的那个（fanproxy 只用 certbot 的 webroot 插件，已装 certbot 时不会再装插件包）。按发行版选择包管理器（apt / dnf / yum / apk / zypper / pacman），并按初始化系统写服务：
systemd 用 `deploy/fanproxy.service`，OpenRC 用 `deploy/fanproxy.openrc`。默认安装到 `/opt/fanproxy`，配置写在 `/etc/fanproxy/config.json`
（可用 `PREFIX=` / `CONF_DIR=` 覆盖）。

```bash
sudo bash deploy/uninstall.sh        # 交互式卸载：逐项询问是否删除配置、nginx、certbot
sudo bash deploy/uninstall.sh -y     # 只卸载 fanproxy，保留配置 / nginx / certbot
REMOVE_NGINX=1 REMOVE_CERTBOT=1 REMOVE_CONFIG=1 sudo bash deploy/uninstall.sh -y   # 全清（脚本模式）
```

卸载脚本会停止并删除 `fanproxy.service`（同时清理改名前的 `fan.service`），卸载 nginx 只做
`apt/dnf/yum/apk remove`（保留 `/etc/nginx` 配置），卸载 certbot 不会删 `/etc/letsencrypt` 里的证书。

从旧版本（项目还叫 `fan`）迁移：

```bash
sudo cp -r /opt/fan/data /opt/fanproxy/data          # 站点数据
sudo cp /etc/fan/config.json /etc/fanproxy/config.json   # 面板配置
```

旧站点在 nginx 里的 conf（`fan-*.conf`）和 `# 由 fan 自动生成` 标记仍然被识别，原有站点不用重建；
新站点的文件名前缀是 `fanproxy-`，可用 `nginx.filePrefix` 改回。

## 测试

```bash
bash scripts/smoke.sh     # 桩程序替换 nginx/certbot，跑通主要 API 流程
npm run compat            # 校验 Node 版本下限（CI 可用，越界时退出码非 0）
```

## 界面设计

面板界面遵循仓库根目录的 `DESIGN.md` 设计系统：黑 / 白 / 蓝三画布章节结构、SST 风格的轻字重（weight 300）标题、
PlayStation Blue `#0070d1` 作为唯一主操作色、全圆角胶囊按钮（48px）、8px 圆角卡片、4px 圆角输入框，
不使用阴影与渐变，章节之间靠背景色切换分隔。蓝色只出现在主 CTA、状态徽标与页脚带上。

面板支持 hash 深链（`/#logs`、`/#backups` 等），部署后可直接分享到某个标签页。

## 目录结构

```
bin/fanproxy.js           启动入口（ES5 版本守卫）
scripts/node-compat.js  Node 版本下限检查
src/web/             面板前端（原生 JS）
src/http/            HTTP 服务、路由、鉴权
src/core/manager.js  编排：apply / 证书 / 回滚 / 健康检查
src/core/nginx.js    nginx 命令封装
src/core/certbot.js  certbot 命令封装
src/core/renderer.js 站点模型 → nginx 配置
src/core/backup.js   配置快照与回滚
src/core/logs.js     访问日志解析统计
src/core/auth.js     账号与会话
src/core/platform.js 发行版识别与路径/服务管理器默认值
src/core/scheduler.js 自动续期调度
src/store.js         站点持久化
src/config.js        配置加载
```

## 后续可做

- 负载均衡组与多上游配置
- 证书到期告警（邮件 / Webhook）
- 日志的实时 tail（WebSocket 推送）
- 面板自身 HTTPS 与反向代理嵌套部署
