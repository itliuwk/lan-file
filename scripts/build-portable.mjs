import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { inject } from "postject";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("请在 Windows x64 上生成此便携版本。");
if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error(
    "打包需要 Node.js 22.12+，其他电脑运行 EXE 不需要安装 Node.js。",
  );
const work = path.join(root, ".packaging");
const release = path.join(root, "release");
await fs.mkdir(work, { recursive: true });
await fs.mkdir(release, { recursive: true });
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw result.error || new Error(command + " 运行失败");
};
run(process.execPath, ["node_modules/vite/bin/vite.js", "build"]);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};
const assets = {};
async function collect(folder, prefix = "") {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const name = prefix + "/" + entry.name;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) await collect(full, name);
    else
      assets[name] = {
        type: types[path.extname(entry.name)] || "application/octet-stream",
        data: (await fs.readFile(full)).toString("base64"),
      };
  }
}
await collect(path.join(root, "dist"));
await fs.writeFile(path.join(work, "assets.json"), JSON.stringify(assets));
const bundled = path.join(work, "app.cjs");
await build({
  absWorkingDir: root,
  entryPoints: ["scripts/portable-entry.js"],
  outfile: bundled,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: true,
  external: ["vite", "bufferutil", "utf-8-validate"],
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.WS_NO_BUFFER_UTIL": '"1"',
    "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
  },
});
const blob = path.join(work, "sea.blob");
const config = path.join(work, "sea-config.json");
await fs.writeFile(
  config,
  JSON.stringify({
    main: bundled,
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }),
);
run(process.execPath, ["--experimental-sea-config", config]);
const stagingExe = path.join(work, `landrop-${Date.now()}.exe`);
await fs.copyFile(process.execPath, stagingExe);
// The modified executable cannot retain Node's Authenticode signature.
// Clear only the PE security directory; the executable's code is unchanged.
const pe = await fs.readFile(stagingExe);
const peHeader = pe.readUInt32LE(0x3c);
const optionalHeader = peHeader + 24;
if (pe.readUInt16LE(optionalHeader) !== 0x20b)
  throw new Error("需要 x64 PE32+ Node.js 运行环境。");
pe.fill(0, optionalHeader + 112 + 8 * 4, optionalHeader + 112 + 8 * 5);
await fs.writeFile(stagingExe, pe);
await inject(stagingExe, "NODE_SEA_BLOB", await fs.readFile(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
});
let exe = path.join(release, "轻传-Windows-x64.exe");
try {
  await fs.rename(stagingExe, exe);
} catch (error) {
  if (!["EBUSY", "EPERM", "EACCES", "EEXIST"].includes(error.code)) throw error;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  exe = path.join(release, `轻传-Windows-x64-${stamp}.exe`);
  await fs.rename(stagingExe, exe);
  console.log("旧版本正在运行或被占用，本次输出为：" + path.basename(exe));
}

const usage = `轻传 · Windows x64 便携版\r\n\r\n1. 把「轻传-Windows-x64.exe」复制到任意 Windows 10/11 x64 电脑。\r\n2. 双击 EXE，会自动打开浏览器，无需安装 Node.js 或依赖，无需编译。\r\n3. 同一 Wi-Fi 下，另一台设备扫码或打开复制的连接链接即可传输。\r\n4. 使用期间保留启动窗口；关闭窗口即退出。\r\n\r\n只有一台电脑需要运行程序，其他设备仅需浏览器。\r\n如果想让另一台电脑独立使用，也可以把 EXE 复制过去。\r\n两台电脑都运行时，请打开同一个连接链接进行配对。\r\n\r\n若 3000 端口已被占用，程序会自动选用后续空闲端口。\r\n如手机打不开页面，请允许本程序通过 Windows 防火墙的专用网络。\r\n浏览器单文件接收限制等说明见应用内「使用帮助」。\r\n\r\n退出后不会保留传输记录或未保存的文件。\r\n`;
await fs.writeFile(
  path.join(release, "使用说明.txt"),
  "\ufeff" + usage.replaceAll("轻传-Windows-x64.exe", path.basename(exe)),
);

let licenses = "LAN Drop third-party notices\n\n";
const lock = JSON.parse(
  await fs.readFile(path.join(root, "package-lock.json"), "utf8"),
);
for (const [packagePath, info] of Object.entries(lock.packages).sort()) {
  if (!packagePath.startsWith("node_modules/") || info.dev) continue;
  const name = packagePath.replace(/^node_modules\//, "");
  const directory = path.join(root, packagePath);
  for (const file of await fs.readdir(directory).catch(() => [])) {
    if (/^licen[cs]e(?:[.\-]|$)|^copying/i.test(file)) {
      const full = path.join(directory, file);
      if ((await fs.stat(full)).isFile())
        licenses +=
          "\n--- " +
          name +
          " / " +
          file +
          " ---\n" +
          (await fs.readFile(full, "utf8")) +
          "\n";
    }
  }
}
const nodeLicense = path.join(work, `NODE-${process.version}-LICENSE.txt`);
try {
  await fs.access(nodeLicense);
} catch {
  const response = await fetch(
    "https://raw.githubusercontent.com/nodejs/node/" +
      process.version +
      "/LICENSE",
  );
  if (!response.ok)
    throw new Error("无法下载 Node.js 授权文件，请联网后重新打包。");
  await fs.writeFile(nodeLicense, await response.text());
}
licenses +=
  "\n--- Node.js " +
  process.version +
  " ---\n" +
  (await fs.readFile(nodeLicense, "utf8"));
await fs.writeFile(path.join(release, "第三方许可.txt"), licenses);
const archive = path.join(release, "轻传-Windows-x64.zip");
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
run("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "Compress-Archive -LiteralPath " +
    [
      exe,
      path.join(release, "使用说明.txt"),
      path.join(release, "第三方许可.txt"),
    ]
      .map(quote)
      .join(",") +
    " -DestinationPath " +
    quote(archive) +
    " -Force",
]);
console.log("\n便携版本已生成：" + exe + "\n分享压缩包：" + archive);
await fs.writeFile(
  path.join(release, "latest.json"),
  JSON.stringify(
    {
      executable: path.basename(exe),
      archive: path.basename(archive),
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
