const path = require('path');

const repoDir = process.env.STREAMVAULT_FEATURE_DIR || '/home/opc/StreamVault-Feature';
const appName = process.env.STREAMVAULT_FEATURE_APP || 'stalker-proxy-play';

module.exports = {
  apps: [{
    name: appName,
    script: 'src/index.js',
    cwd: path.join(repoDir, 'stalker-proxy'),
    instances: 1,
    exec_mode: 'fork',
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 5_000,
    exp_backoff_restart_delay: 100,
    kill_timeout: 10_000,
    max_memory_restart: process.env.STREAMVAULT_MAX_MEMORY || '600M',
    time: true,
    merge_logs: true,
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || '3201',
    },
  }],
};
