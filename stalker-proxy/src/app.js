require("dotenv").config();
const express = require("express");

function createApp(deps) {
  const app = express();
  if (process.env.TRUST_PROXY !== "false") app.set("trust proxy", 1);

  app.get("/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  return app;
}

module.exports = { createApp };