import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { WebSocket } from "ws";
import { clientAddress, discoveryScopes } from "../server/discovery.js";
const port = 3018;
let server;
const clients = [];
before(async () => {
  server = spawn(process.execPath, ["server/index.js"], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
    windowsHide: true,
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server did not start");
});
after(() => {
  for (const ws of clients) ws.terminate();
  server?.kill();
});
async function client(headers = {}) {
  const ws = new WebSocket(`ws://localhost:${port}/signal`, {
    origin: `http://localhost:${port}`,
    headers,
  });
  clients.push(ws);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}
function next(ws, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", listener);
      reject(new Error(`Timeout: ${type}`));
    }, 3000);
    function listener(raw) {
      const data = JSON.parse(raw);
      if (data.type === type) {
        clearTimeout(timeout);
        ws.off("message", listener);
        resolve(data);
      }
    }
    ws.on("message", listener);
  });
}
const send = (ws, data) => ws.send(JSON.stringify(data));
test("discovery uses actual subnet masks and trusts only configured proxy hops", () => {
  const networks = [
    { address: "192.168.10.4", netmask: "255.255.254.0" },
    { address: "10.2.0.4", netmask: "255.255.255.0" },
    { address: "203.0.113.4", netmask: "255.255.255.0" },
  ];
  const shared = (a, b) =>
    discoveryScopes(a, networks).some((scope) =>
      discoveryScopes(b, networks).includes(scope),
    );
  assert.ok(shared("127.0.0.1", "192.168.11.40"));
  assert.ok(shared("192.168.10.20", "192.168.11.40"));
  assert.ok(!shared("192.168.10.20", "192.168.12.40"));
  assert.ok(!shared("192.168.10.20", "10.2.0.40"));
  assert.ok(!shared("203.0.113.1", "203.0.113.2"));
  assert.ok(shared("203.0.113.1", "203.0.113.1"));
  const request = {
    socket: { remoteAddress: "::ffff:192.168.10.20" },
    headers: { "x-forwarded-for": "203.0.113.1, 198.51.100.2" },
  };
  assert.equal(clientAddress(request), "192.168.10.20");
  assert.equal(clientAddress(request, ["192.168.10.20"]), "198.51.100.2");
  request.socket.remoteAddress = "::1";
  assert.equal(clientAddress(request), "198.51.100.2");
  request.headers["x-forwarded-for"] = "invalid";
  assert.equal(clientAddress(request), "::1");
});

test("discovery isolates networks, connects atomically, and updates busy/offline peers", async (t) => {
  const a = await client({ "x-forwarded-for": "203.0.113.10" });
  const b = await client({ "x-forwarded-for": "203.0.113.10" });
  const c = await client({ "x-forwarded-for": "203.0.113.11" });
  const d = await client({ "x-forwarded-for": "203.0.113.10" });
  t.after(() => [a, b, c, d].forEach((ws) => ws.terminate()));
  async function register(ws, device = "desktop") {
    const room = next(ws, "room");
    const list = next(ws, "devices");
    send(ws, { type: "create", device, discovery: true });
    return { ...(await room), ...(await list) };
  }
  const originalA = await register(a);
  assert.deepEqual(originalA.devices, []);
  const updatedA = next(a, "devices");
  const originalB = await register(b, "mobile");
  assert.equal((await updatedA).devices[0].id, originalB.self.id);
  assert.equal(originalB.devices[0].id, originalA.self.id);
  assert.equal(originalB.self.device, "mobile");
  assert.equal(originalB.devices[0].code, undefined);
  const originalC = await register(c);
  assert.deepEqual(originalC.devices, []);
  const denied = next(c, "error");
  send(c, { type: "connect-device", id: originalA.self.id });
  await denied;
  await register(d);
  const pairedA = next(a, "peer-joined");
  const pairedB = next(b, "peer-joined");
  const busyList = next(d, "devices");
  send(a, { type: "connect-device", id: originalB.self.id });
  assert.equal((await pairedA).initiator, false);
  assert.equal((await pairedB).initiator, true);
  assert.ok((await busyList).devices.every((device) => !device.available));
  const occupied = next(d, "error");
  send(d, { type: "connect-device", id: originalB.self.id });
  assert.match((await occupied).message, /正在连接其他设备/);
  const missing = next(c, "error");
  send(c, { type: "join", code: originalA.code });
  // C still owns its original waiting room after the rejected discovery request.
  assert.match((await missing).message, /请先断开/);
  const signal = next(b, "signal");
  send(a, { type: "signal", signal: { candidate: "discovered-peer" } });
  assert.equal((await signal).signal.candidate, "discovered-peer");
  const left = next(b, "peer-left");
  const offline = next(d, "devices");
  a.close();
  await left;
  const remaining = (await offline).devices;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, originalB.self.id);
  assert.equal(remaining[0].available, true);
  const reconnected = next(b, "peer-joined");
  send(d, { type: "connect-device", id: originalB.self.id });
  await reconnected;
});
test("private scan token connects two devices, isolates signaling, and allows reconnect", async () => {
  const a = await client();
  const b = await client();
  const c = await client();
  const created = next(a, "room");
  send(a, { type: "create" });
  const { code } = await created;
  assert.match(code, /^[a-f0-9]{36}$/);
  const pairedA = next(a, "peer-joined");
  const pairedB = next(b, "peer-joined");
  send(b, { type: "join", code, device: "mobile" });
  assert.equal((await pairedA).initiator, true);
  assert.equal((await pairedB).initiator, false);
  const full = next(c, "error");
  send(c, { type: "join", code });
  assert.match((await full).message, /已连接其他设备/);
  const relay = next(b, "signal");
  send(a, {
    type: "signal",
    signal: { description: { type: "offer", sdp: "test" } },
  });
  assert.equal((await relay).signal.description.sdp, "test");
  const left = next(a, "peer-left");
  send(b, { type: "leave" });
  await left;
  const rejoin = next(a, "peer-joined");
  send(c, { type: "join", code });
  await rejoin;
  const oldLeftA = next(a, "left");
  const oldLeftC = next(c, "left");
  send(a, { type: "leave" });
  send(c, { type: "leave" });
  await Promise.all([oldLeftA, oldLeftC]);
  const missing = next(b, "error");
  send(b, { type: "join", code });
  assert.match((await missing).message, /已失效/);
});
test("rejects websocket connections from unrelated origins", async () => {
  const ws = new WebSocket(`ws://localhost:${port}/signal`, {
    origin: "https://unrelated.example",
  });
  const error = await new Promise((resolve) => ws.once("error", resolve));
  assert.match(error.message, /403/);
});

test("accepts a public origin forwarded by an HTTPS reverse proxy", async (t) => {
  const publicHost = "lan-file.example.com";
  const ws = new WebSocket(`ws://localhost:${port}/signal`, {
    origin: `https://${publicHost}`,
    headers: {
      "x-forwarded-host": publicHost,
      "x-forwarded-proto": "https",
      "x-forwarded-for": "192.168.1.88",
    },
  });
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const created = next(ws, "room");
  send(ws, { type: "create" });
  assert.match((await created).code, /^[a-f0-9]{36}$/);
});

test(
  "automatically switches from an occupied port and serves HTTP and WebSocket on the new port",
  { timeout: 15000 },
  async (t) => {
    const occupied = net.createServer();
    await new Promise((resolve) => occupied.listen(0, "0.0.0.0", resolve));
    t.after(() => new Promise((resolve) => occupied.close(resolve)));
    const initialPort = occupied.address().port;
    if (initialPort === 65535)
      return t.skip("No higher port is available to test");
    const child = spawn(
      process.execPath,
      ["server/index.js", "--port", String(initialPort)],
      {
        env: { ...process.env, PORT: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode !== null) return;
      return new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      });
    });
    let output = "";
    const actualPort = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Startup timed out: " + output)),
        10000,
      );
      child.stdout.on("data", (data) => {
        output += data;
        const found = output.match(/http:\/\/localhost:(\d+)/);
        if (found) {
          clearTimeout(timeout);
          resolve(Number(found[1]));
        }
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Exited with ${code}: ${output}`));
      });
    });
    assert.ok(
      actualPort > initialPort &&
        actualPort <= Math.min(initialPort + 20, 65535),
    );
    assert.match(output, /已被占用/);
    const base = `http://localhost:${actualPort}`;
    assert.equal((await (await fetch(base + "/api/health")).json()).ok, true);
    assert.equal(
      (await (await fetch(base + "/api/network")).json()).port,
      actualPort,
    );
    const ws = new WebSocket(`ws://localhost:${actualPort}/signal`, {
      origin: base,
    });
    t.after(() => ws.terminate());
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const created = next(ws, "room");
    send(ws, { type: "create" });
    assert.match((await created).code, /^[a-f0-9]{36}$/);
  },
);
