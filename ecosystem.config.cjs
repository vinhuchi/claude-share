// pm2 process config for the always-on sharer.
//
//   pm2 start ecosystem.config.cjs
//
// The app now self-heals the bore tunnel in-process (auto-respawn + watchdog),
// so pm2 here is the safety net for the failure modes only a process restart
// can fix: hard crashes, EMFILE self-exit, OOM (max_memory_restart), and a
// nightly recycle. `--duration=unlimited` keeps the session (and paired
// machines) alive across days so receivers don't have to re-pair; drop it if
// you want a time-boxed share.
module.exports = {
  apps: [
    {
      name: "claude-share",
      script: "dist/claude-share/index.js",
      args: "--headless --duration=unlimited",
      autorestart: true,
      max_memory_restart: "400M",
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 2000,
      cron_restart: "0 4 * * *", // nightly recycle (04:00) — cheap safety net
      env: {
        NODE_ENV: "production",
        BORE_FIXED_PORT: "39863",
      },
    },
  ],
};
