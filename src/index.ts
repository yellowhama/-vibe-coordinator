/**
 * Vibe Coordinator
 * ================
 * Minimal coordination server for Vibe PM.
 *
 * Handles:
 * - License issue/verify
 * - Version check
 * - Usage tracking (anonymous)
 * - Stripe webhooks
 *
 * Does NOT handle:
 * - AI/model execution
 * - File scanning
 * - Any computation
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { logger } from "hono/logger";
import { cors } from "hono/cors";

import { config, validateConfig } from "./lib/config.js";
import { initDb } from "./lib/db.js";

import healthRoutes from "./routes/health.js";
import versionRoutes from "./routes/version.js";
import licenseRoutes from "./routes/license.js";
import usageRoutes from "./routes/usage.js";
import stripeRoutes from "./routes/stripe.js";

// Validate configuration
validateConfig();

// Create app
const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST"],
  allowHeaders: ["Content-Type", "X-API-Key", "stripe-signature"],
}));

// Routes
app.route("/", healthRoutes);
app.route("/", versionRoutes);
app.route("/", licenseRoutes);
app.route("/", usageRoutes);
app.route("/", stripeRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ error: "NOT_FOUND", message: "Endpoint not found" }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error("[error]", err);
  return c.json({ error: "INTERNAL_ERROR", message: "Internal server error" }, 500);
});

// Start server
async function main() {
  console.log(`[coordinator] Initializing database...`);
  await initDb();

  console.log(`[coordinator] Starting on port ${config.port}...`);
  serve({
    fetch: app.fetch,
    port: config.port,
  });
  console.log(`[coordinator] Ready at http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error("[coordinator] Failed to start:", err);
  process.exit(1);
});
