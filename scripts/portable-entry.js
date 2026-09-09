import { startServer } from "../server/application.js";
import assets from "../.packaging/assets.json";

startServer({ assets, openBrowser: true, fallbackPorts: true }).catch(
  (error) => {
    console.error("轻传启动失败：", error.message);
    console.error("请关闭占用端口的程序后重试。按 Enter 退出。");
    process.exitCode = 1;
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(1));
  },
);
