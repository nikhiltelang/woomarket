// PM2 process file: `pm2 start ecosystem.config.cjs && pm2 save`
// Cluster mode is supported; only instance 0 runs the message queue and cron jobs.
// Socket.IO across several instances needs sticky sessions at the load balancer.
module.exports = {
  apps: [
    {
      name: "woomarket360",
      script: "dist/index.js",
      node_args: "--enable-source-maps",
      instances: Number(process.env.INSTANCES || 1),
      exec_mode: Number(process.env.INSTANCES || 1) > 1 ? "cluster" : "fork",
      instance_var: "NODE_APP_INSTANCE",
      env: { NODE_ENV: "production" },
      max_memory_restart: "1G",
      kill_timeout: 10000,
      listen_timeout: 15000,
      merge_logs: true,
      time: true,
    },
  ],
};
