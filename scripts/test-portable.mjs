import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "landrop-portable-"));
const executable = path.join(temporary, "轻传.exe");
const latest = JSON.parse(
  await fs.readFile(path.join(root, "release", "latest.json"), "utf8"),
);
if (path.basename(latest.executable) !== latest.executable)
  throw new Error("打包产物路径无效");
await fs.copyFile(path.join(root, "release", latest.executable), executable);
console.log("在只有 EXE 的独立目录中验证：" + temporary);
const env = { ...process.env, LANDROP_PORTABLE_EXE: executable };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
const child = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test"],
  { cwd: root, env, stdio: "inherit", windowsHide: true },
);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
await fs.unlink(executable);
await fs.rmdir(temporary);
process.exitCode = code ?? 1;
