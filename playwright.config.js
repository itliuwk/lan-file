import { defineConfig } from "@playwright/test";
import path from "node:path";
const portable = process.env.LANDROP_PORTABLE_EXE;
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45000,
  use: {
    baseURL: "http://localhost:3017",
    headless: true,
    screenshot: "only-on-failure",
    launchOptions: { channel: "msedge" },
  },
  workers: 1,
  webServer: {
    command: portable
      ? `"${portable}" --no-open --port 3017`
      : "node server/index.js",
    cwd: portable ? path.dirname(portable) : undefined,
    env: portable
      ? {
          PORT: "3017",
          NODE_OPTIONS: "",
          NODE_PATH: "",
          PATH: `${process.env.SystemRoot}\\System32`,
        }
      : { PORT: "3017" },
    url: "http://localhost:3017/api/health",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
