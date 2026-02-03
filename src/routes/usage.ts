/**
 * Usage tracking endpoint (anonymous analytics)
 */

import { Hono } from "hono";
import { incrementUsage } from "../lib/db.js";

const app = new Hono();

interface UsageEvent {
  type: string;
  count: number;
}

interface UsagePingBody {
  client_id: string;
  version: string;
  events: UsageEvent[];
  plan: "FREE" | "PRO";
  os: string;
  arch: string;
}

/**
 * POST /v1/usage/ping
 * Record anonymous usage data
 */
app.post("/v1/usage/ping", async (c) => {
  const body = await c.req.json<UsagePingBody>();

  // Validate minimal structure
  if (!body.client_id || !Array.isArray(body.events)) {
    return c.json({ ack: false }, 400);
  }

  // Record usage (fire and forget)
  const today = new Date().toISOString().slice(0, 10);
  const plan = body.plan || "FREE";

  try {
    for (const event of body.events) {
      if (event.type && typeof event.count === "number") {
        incrementUsage(today, plan, event.type, event.count);
      }
    }
  } catch (e) {
    // Don't fail the request if DB write fails
    console.error("[usage] Failed to record:", e);
  }

  return c.json({ ack: true });
});

export default app;
