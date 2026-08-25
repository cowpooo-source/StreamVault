module.exports = {
  apps: [
    {
      name: "stalker-proxy-sandbox",
      script: "src/index.js",
      cwd: "/home/opc/StreamVault-sandbox/stalker-proxy",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "3101",
        CACHE_DB: "/home/opc/StreamVault-sandbox/stalker-proxy/data/cache-sandbox.db",
      },
    },
  ],
};
