/**
 * Version check endpoint
 */

import { Hono } from "hono";
import { config } from "../lib/config.js";

const app = new Hono();

app.get("/v1/version", (c) => {
  return c.json({
    latest: config.latestClientVersion,
    minimum: config.minimumClientVersion,
    deprecated_before: "0.9.0",
    changelog_url: "https://github.com/yellowhama/vibe-pm/releases",
    features: {
      ant_lane: true,
      hive_link: false,
      scorecard: true,
      policy_analysis: true,
    },
  });
});

export default app;
