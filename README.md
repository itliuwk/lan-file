# 轻传 · 局域网文件快传

打开页面自动生成二维码，另一台设备扫码后直接连接，双向发送文件和文字。无需房间码、账号或外部服务。

## 打包为双击启动的程序

在当前项目中执行：

```sh
npm run package:win
```

命令会自动构建页面，把服务、前端资源和 Node.js 运行环境合并为一个 EXE，并生成分发压缩包：

- `release/轻传-Windows-x64.exe`：双击启动，自动打开浏览器。
- `release/轻传-Windows-x64.zip`：包含 EXE、使用说明和第三方许可，方便复制到其他电脑。

目标电脑只需要 Windows 10/11 x64 和浏览器，**不需要安装 Node.js、npm 或项目依赖，也不需要重新构建**。不必复制源码、`dist` 或 `node_modules`。使用期间保持启动窗口打开，关闭窗口即可退出；默认端口被占用时自动选择后续空闲端口。

重新打包时如果旧 EXE 正在运行，命令会生成带时间戳的新 EXE，并将新版本放进 ZIP，不会中断正在使用的程序。实际输出路径显示在打包日志中，也记录在 `release/latest.json`。

只有负责打包的开发电脑需要 Node.js 22.12+ 和项目依赖；第一次拉取项目先运行 `npm ci`，后续改完代码执行打包命令即可。首次打包会下载对应 Node.js 版本的授权文件，之后使用本地缓存。

只有一台电脑需要启动服务，其他电脑、手机可以打开同一个连接链接使用。如果其他电脑也想独立启动应用，复制 EXE 过去即可。

验证打包产物：

```sh
npm run test:portable
```

测试会把 EXE 单独复制到临时目录，在清除 Node.js 搜索路径的环境中启动，再验证二维码、双向文字、文件校验和重连。

## 部署与 PM2 进程守护

需要 Node.js 20.19+ 或 22.12+。

开发或部署电脑可以执行以下命令；其他电脑直接使用上面的便携版 EXE。

```sh
npm install
npm run build
npm start
```

`npm start` 使用项目内安装的 PM2 在后台启动 `lan-drop`，同时提供页面和 WebSocket 服务。关闭终端不会停止服务，进程异常退出后会自动重启，无需全局安装 PM2。

```sh
npm run status       # 查看运行状态
npm run logs         # 持续查看日志，Ctrl+C 仅退出日志查看
npm run restart      # 重启服务
npm stop             # 停止服务
npm run pm2:delete   # 从 PM2 进程列表移除本应用
npm run start:direct # 不使用 PM2，前台运行
```

配置文件为 `ecosystem.config.cjs`，默认起始端口 3000，可通过 `PORT` 环境变量覆盖。如果端口被占用，自动依次尝试 3001、3002 等后续端口（最多尝试至起始端口 + 20），终端或 PM2 日志会显示实际访问地址；二维码和 WebSocket 使用实际端口。连接配对数据存在内存中，因此固定单进程；服务重启后需要重新扫码连接。更新前端后重新执行 `npm run build`，更新服务后执行 `npm run restart`。

服务器部署需要 `dist/`、`server/`、`ecosystem.config.cjs`、`package.json` 和 `package-lock.json`，在目标机器执行 `npm ci --omit=dev` 后运行 `npm start`。只上传 `dist` 不包含配对服务。

PM2 进程守护不等于系统开机自启。Linux 服务器需要开机恢复时，在该服务器执行 `npx pm2 startup` 并按输出完成配置，然后执行 `npx pm2 save`；Windows 需另行配置系统服务或任务计划。本项目不会自动修改系统启动项。便携 EXE 保持原来的双击启动方式，不需要 PM2。

### 宝塔面板 HTTPS / WSS 反向代理

宝塔的 Node 项目管理器已经提供进程守护，启动命令建议填写 `npm run start:direct`，避免在宝塔守护进程中再嵌套一个 PM2。确认项目日志中的实际端口，然后让网站反向代理到该端口。生产环境建议固定并确保 3000 可用，避免应用自动换端口后代理仍指向旧端口。

在「网站 → 反向代理」中开启 WebSocket 支持。若当前宝塔版本没有该开关，编辑反向代理配置，把 [deploy/baota-nginx-location.conf](deploy/baota-nginx-location.conf) 中的 `location /` 配置应用到站点；关键配置是：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
```

修改后重载 Nginx，并在浏览器访问 `https://你的域名/api/health`。正常结果包含 `"ok":true` 和 `"websocket":"/signal"`。随后刷新首页，开发者工具中的 `wss://你的域名/signal` 应返回 HTTP `101 Switching Protocols`，二维码会随即生成。

如果宝塔通过 Docker 或另一层代理转发，建议给 Node 项目设置 `PUBLIC_ORIGIN=https://你的域名`，然后重启项目。域名、SSL 证书和反向代理必须属于同一个站点；Cloudflare 等上游代理也需要允许 WebSocket。

电脑浏览器打开启动日志中显示的地址（默认 `http://localhost:3000`），让手机连接同一个 Wi-Fi，用相机扫描页面二维码并在浏览器中打开。电脑之间可点击「复制连接链接」，在另一台电脑打开。

如扫码后页面无法打开，检查 Windows 防火墙是否允许 Node.js 使用专用网络。多网卡电脑可在二维码下方选择实际使用的网络地址。访客 Wi-Fi、AP 隔离和部分 VPN 可能阻止设备互相连接。

开发模式：`npm run dev`。开发、前台运行和 PM2 启动均支持端口自动切换。也可以使用 `npm run start:direct -- --port 4000` 指定起始端口。

## 使用

- 首页自动显示二维码；扫码立即配对，不需要创建或输入房间码。
- 连接后选择、拖入文件或粘贴图片。对方点击「保存并接收」后开始传输。
- 支持批量选择（每批最多 30 个文件）、实时进度、速度、取消与拒收。
- 支持文字消息、复制消息；Enter 发送，Shift + Enter 换行。
- 断开后可重新扫码；等待二维码在 30 分钟后自动刷新。
- 传输记录仅保留在当前标签页，刷新或关闭会清空。请及时保存接收到的文件。

## 文件保存与兼容性

现代 Chrome、Edge、Safari 和 Firefox 可使用 WebRTC 直连；实际连接仍取决于设备网络和浏览器策略。手机建议使用系统浏览器打开二维码链接。

在支持 File System Access API 的安全上下文（桌面 Chrome / Edge 的 localhost 或 HTTPS）中，先选择保存位置，文件分块直接写入磁盘。普通局域网 HTTP、手机和其他浏览器使用内存接收，单文件及同时接收的内存预算为 256 MB。内存模式完成后需要点击「保存文件」。已完成但未保存的文件仍占用浏览器内存，请及时保存并在不再需要时刷新页面。

## 实现

React + Vite 界面，Express 提供页面和网卡信息，WebSocket 交换 WebRTC 信令。页面自动申请随机 144 位连接令牌并写入二维码，只允许两台设备配对。文件与文字经有序 WebRTC DataChannel 传输，不通过服务器转发；没有 STUN、TURN、云存储或外部字体依赖，构建后可在无外网的局域网运行。

文件以 64 KB 分块发送，带发送缓冲区背压、接收确认、大小校验与取消处理。WebRTC 数据通道使用 DTLS 加密；默认页面和信令使用局域网 HTTP / WS，不适合直接作为公网服务暴露。当前不支持断点续传或文件夹传输。

## 验证

```sh
npm test
npm run build
npm run test:e2e
```

端到端测试默认使用 Windows 上的 Microsoft Edge，在 3017 端口启动独立服务；服务测试使用 3018 端口。测试解码真实二维码，通过电脑局域网 IP 打开第二个浏览器会话，校验双向文字、文件字节、零字节文件、拒收、重新扫码与手机布局。运行需要一个可用 IPv4 局域网网卡。

界面截图保存在 `artifacts/`。
