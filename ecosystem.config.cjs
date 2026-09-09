const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "lan-drop",
      cwd: __dirname,
      script: path.join(__dirname, "server/index.js"),
      interpreter: process.execPath,
      // Pairing state is held in memory; all devices must reach one process.
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 2000,
      wait_ready: true,
      listen_timeout: 10000,
      kill_timeout: 5000,
      shutdown_with_message: true,
      time: true,
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3000,
      },
    },
  ],
};
