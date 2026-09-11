import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { clientAddress, discoveryScopes } from "./discovery.js";

import { spawn } from "node:child_process";

export async function startServer({
  root,
  assets,
  openBrowser = false,
  fallbackPorts = false,
  dev = false,
} = {}) {
  const app = express();
  const server = http.createServer(app);
  const portFlag = process.argv.indexOf("--port");
  let port = Number(
    portFlag >= 0 ? process.argv[portFlag + 1] : process.env.PORT || 3000,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口必须为 1 到 65535 之间的整数。");
  const rooms = new Map();
  const attempts = new Map();
  const send = (ws, data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };
  const firstHeader = (value) =>
    String(Array.isArray(value) ? value[0] : value || "")
      .split(",")[0]
      .trim();
  const trustedProxies = (process.env.TRUSTED_PROXIES || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  const address = (req) => clientAddress(req, trustedProxies);
  const discoveryNetworks = Object.values(os.networkInterfaces())
    .flat()
    .filter((network) => network.family === "IPv4" && !network.internal);
  const requestHosts = (req) => {
    const hosts = [
      firstHeader(req.headers.host),
      firstHeader(req.headers["x-forwarded-host"]),
    ];
    if (process.env.PUBLIC_ORIGIN) {
      try {
        hosts.push(new URL(process.env.PUBLIC_ORIGIN).host);
      } catch {
        console.warn("  PUBLIC_ORIGIN 格式无效，应为 https://example.com");
      }
    }
    return new Set(hosts.filter(Boolean).map((host) => host.toLowerCase()));
  };
  const interfaces = () =>
    Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
      entries
        .filter((i) => i.family === "IPv4" && !i.internal)
        .map((i) => ({ name, ip: i.address })),
    );

  app.get("/api/network", (req, res) =>
    res.json({ interfaces: interfaces(), port, clientIp: address(req) }),
  );
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, websocket: "/signal", port }),
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const sameNetwork = (a, b) =>
    a.scopes.some((scope) => b.scopes.includes(scope));
  const available = (ws) =>
    ws.readyState === WebSocket.OPEN && rooms.get(ws.room)?.members.size === 1;
  const deviceInfo = (ws) => ({
    id: ws.id,
    name: ws.name,
    device: ws.device,
    ip: ws.ip,
    available: available(ws),
  });
  function publishDevices() {
    const registered = [...wss.clients].filter(
      (ws) => ws.discovery && ws.room && ws.readyState === WebSocket.OPEN,
    );
    for (const ws of wss.clients) {
      if (!ws.discovery) continue;
      send(ws, {
        type: "devices",
        self: deviceInfo(ws),
        devices: registered
          .filter((peer) => peer !== ws && sameNetwork(ws, peer))
          .map(deviceInfo),
      });
    }
  }
  function pair(ws, peer, code) {
    const room = rooms.get(code);
    room.members.add(ws);
    ws.room = code;
    send(ws, { type: "room", code, ip: ws.ip });
    send(ws, { type: "peer-joined", initiator: false, ...deviceInfo(peer) });
    send(peer, { type: "peer-joined", initiator: true, ...deviceInfo(ws) });
  }
  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/signal") {
      // Vite handles its own HMR socket in development.
      if (!dev) socket.destroy();
      return;
    }
    let valid = false;
    try {
      valid = requestHosts(req).has(
        new URL(req.headers.origin).host.toLowerCase(),
      );
    } catch {}
    if (!valid) {
      console.warn(
        `  已拒绝 WebSocket：Origin=${req.headers.origin || "-"} Host=${req.headers.host || "-"} X-Forwarded-Host=${req.headers["x-forwarded-host"] || "-"}`,
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });

  function leave(ws) {
    const room = rooms.get(ws.room);
    if (room) {
      room.members.delete(ws);
      if (!room.members.size) rooms.delete(ws.room);
      else for (const peer of room.members) send(peer, { type: "peer-left" });
    }
    ws.room = null;
  }

  wss.on("connection", (ws, req) => {
    ws.ip = address(req);
    ws.id = randomBytes(12).toString("hex");
    ws.scopes = discoveryScopes(ws.ip, discoveryNetworks);
    ws.name = "电脑";
    ws.device = "desktop";
    ws.alive = true;
    ws.on("pong", () => {
      ws.alive = true;
    });
    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!data || typeof data !== "object") return;
      const now = Date.now();
      const rate = attempts.get(ws.ip) || { since: now, count: 0 };
      if (now - rate.since > 60000) {
        rate.since = now;
        rate.count = 0;
      }
      rate.count++;
      attempts.set(ws.ip, rate);
      if (rate.count > 300) {
        send(ws, { type: "error", message: "操作过于频繁，请稍后再试。" });
        return;
      }
      if (data.type === "create" || data.type === "join") {
        if (ws.room) {
          send(ws, { type: "error", message: "请先断开当前连接。" });
          return;
        }
        ws.device = data.device === "mobile" ? "mobile" : "desktop";
        ws.name = `${ws.device === "mobile" ? "移动设备" : "电脑"} · ${ws.id.slice(0, 4).toUpperCase()}`;
        ws.discovery = data.discovery === true;
        if (data.type === "create") {
          if (rooms.size >= 1000) {
            send(ws, { type: "error", message: "服务繁忙，请稍后重试。" });
            return;
          }
          let code;
          do {
            code = randomBytes(18).toString("hex");
          } while (rooms.has(code));
          rooms.set(code, { members: new Set([ws]), createdAt: now });
          ws.room = code;
          send(ws, { type: "room", code, ip: ws.ip });
        } else {
          const code = String(data.code || "");
          const room = rooms.get(code);
          if (!room) {
            send(ws, {
              type: "error",
              message: "连接链接已失效，请让对方刷新二维码后重新扫描。",
            });
            return;
          }
          if (room.members.size >= 2) {
            send(ws, {
              type: "error",
              message: "该设备已连接其他设备，请断开后重新扫码。",
            });
            return;
          }
          const peer = [...room.members][0];
          pair(ws, peer, code);
        }
        publishDevices();
      } else if (data.type === "connect-device") {
        const peer = [...wss.clients].find(
          (candidate) => candidate.id === data.id,
        );
        if (
          !peer ||
          !peer.discovery ||
          peer === ws ||
          !sameNetwork(ws, peer) ||
          !available(peer)
        ) {
          send(ws, {
            type: "error",
            message: "该设备已离线或正在连接其他设备，请选择其他设备。",
          });
          publishDevices();
          return;
        }
        if (!available(ws)) {
          send(ws, {
            type: "error",
            message: "请先断开当前连接，再连接其他设备。",
          });
          return;
        }
        // Validate before leaving: a stale list must never destroy a waiting room.
        const code = peer.room;
        leave(ws);
        pair(ws, peer, code);
        publishDevices();
      } else if (data.type === "signal") {
        const room = rooms.get(ws.room);
        if (room && data.signal && typeof data.signal === "object") {
          for (const peer of room.members)
            if (peer !== ws)
              send(peer, { type: "signal", signal: data.signal });
        }
      } else if (data.type === "leave") {
        leave(ws);
        send(ws, { type: "left" });
        publishDevices();
      }
    });
    ws.on("close", () => {
      leave(ws);
      publishDevices();
    });
    ws.on("error", () => {});
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [ip, entry] of attempts)
      if (now - entry.since > 60000) attempts.delete(ip);
    for (const [code, room] of rooms) {
      if (room.members.size === 1 && now - room.createdAt > 30 * 60 * 1000) {
        for (const ws of room.members) {
          ws.room = null;
          send(ws, { type: "expired" });
        }
        rooms.delete(code);
      }
    }
    publishDevices();
  }, 30000);
  timer.unref();

  if (dev) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (assets) {
    app.use((req, res) => {
      if (!["GET", "HEAD"].includes(req.method)) return res.sendStatus(405);
      let requestPath;
      try {
        requestPath = decodeURIComponent(req.path);
      } catch {
        return res.sendStatus(400);
      }
      const name = requestPath === "/" ? "/index.html" : requestPath;
      const asset = Object.hasOwn(assets, name) ? assets[name] : null;
      if (!asset) return res.sendStatus(404);
      res
        .type(asset.type)
        .set(
          "Cache-Control",
          name.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      res.send(Buffer.from(asset.data, "base64"));
    });
  } else {
    app.use(express.static(path.join(root, "dist")));
    app.get("/{*splat}", (_req, res) =>
      res.sendFile(path.join(root, "dist/index.html")),
    );
  }

  const firstPort = port;
  while (true) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => {
          server.off("listening", ready);
          reject(error);
        };
        const ready = () => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(port, "0.0.0.0");
      });
      break;
    } catch (error) {
      if (
        fallbackPorts &&
        error.code === "EADDRINUSE" &&
        port < Math.min(firstPort + 20, 65535)
      ) {
        console.log(`  端口 ${port} 已被占用，正在尝试 ${port + 1}…`);
        port++;
        continue;
      }
      if (fallbackPorts && error.code === "EADDRINUSE") {
        throw new Error(
          `端口 ${firstPort}–${port} 均被占用，请通过 PORT 或 --port 指定其他起始端口。`,
        );
      }
      throw error;
    }
  }
  const url = "http://localhost:" + port;
  console.log("\n  轻传已启动 · " + url);
  for (const item of interfaces())
    console.log(
      "  局域网地址 · http://" + item.ip + ":" + port + " (" + item.name + ")",
    );
  console.log("  扫码或复制连接链接，即可传输文件。");
  console.log("  使用期间请保持本窗口打开；关闭窗口即可退出。\n");
  if (openBrowser && !process.argv.includes("--no-open")) {
    const child =
      process.platform === "win32"
        ? spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Start-Process '" + url + "'",
            ],
            { windowsHide: true, stdio: "ignore" },
          )
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            stdio: "ignore",
          });
    child.on("error", () => console.log("  请手动在浏览器打开 " + url));
  }
  return {
    server,
    wss,
    port,
    close: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(resolve);
      }),
  };
}
