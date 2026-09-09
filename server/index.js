import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./application.js";

let service;
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 4000);
  deadline.unref();
  try {
    await service?.close();
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    console.error("停止失败：", error.message);
    process.exit(1);
  }
}

startServer({
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  dev: process.argv.includes("--dev"),
  fallbackPorts: true,
})
  .then((instance) => {
    service = instance;
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("message", (message) => {
      if (message === "shutdown") shutdown();
    });
    if (process.send) process.send("ready");
  })
  .catch((error) => {
    console.error("启动失败：", error.message);
    process.exit(1);
  });
