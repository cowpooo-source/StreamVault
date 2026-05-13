const express = require("express");

function createApiRouter() {
  const router = express.Router();
  return router;
}

module.exports = { createApiRouter };