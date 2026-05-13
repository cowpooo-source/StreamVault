const express = require("express");

function createStalkerRouter() {
  const router = express.Router();
  return router;
}

module.exports = { createStalkerRouter };