/**
 * Health check endpoint
 */

import { Hono } from "hono";
import { config } from "../lib/config.js";

const app = new Hono();

const startTime = Date.now();

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    version: config.version,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
  });
});

export default app;
