import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import pm2 from "pm2";
import ecosystem from "../ecosystem.config.cjs";

const call = (method, ...args) =>
  new Promise((resolve, reject) =>
    pm2[method](...args, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "PM2 starts the service, restores it after a crash, and stops it cleanly",
  { timeout: 45000 },
  async () => {
    const reserved = net.createServer();
    await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
    const port = reserved.address().port;
    await new Promise((resolve) => reserved.close(resolve));
    const name = `lan-drop-verification-${process.pid}`;
    await call("connect");
    try {
      await call("start", {
        ...ecosystem.apps[0],
        name,
        env: { ...ecosystem.apps[0].env, PORT: String(port) },
      });
      const health = async () => {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).ok, true);
      };
      await health();
      const [original] = await call("describe", name);
      assert.equal(original.pm2_env.status, "online");
      assert.equal(original.pm2_env.exec_mode, "fork_mode");
      // Only terminate the unique verification process created above.
      process.kill(original.pid, "SIGKILL");
      let recovered = false;
      for (let i = 0; i < 60; i++) {
        await pause(250);
        const [current] = await call("describe", name);
        if (
          current?.pm2_env.status === "online" &&
          current.pid !== original.pid
        ) {
          await health();
          assert.ok(current.pm2_env.restart_time >= 1);
          recovered = true;
          break;
        }
      }
      assert.equal(recovered, true, "PM2 must restore a crashed process");
      await call("restart", name);
      await health();
      await call("stop", name);
      const [stopped] = await call("describe", name);
      assert.equal(stopped.pm2_env.status, "stopped");
      await assert.rejects(() => health());
    } finally {
      await call("delete", name).catch(() => {});
      pm2.disconnect();
    }
  },
);
