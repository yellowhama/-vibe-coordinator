/**
 * License endpoints
 */

import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import {
  signLicense,
  verifyLicense,
  isLicenseExpired,
  type LicensePayload,
  type SignedLicense,
} from "../lib/license.js";
import { createCustomer, findCustomerByEmail, createLicense } from "../lib/db.js";
import { isRevoked, getRevocationInfo } from "../lib/revocation.js";

const app = new Hono();

/**
 * POST /v1/license/issue
 * Issue a new license (called after payment)
 */
app.post("/v1/license/issue", async (c) => {
  try {
    const apiKey = c.req.header("X-API-Key");
    if (!apiKey || !validateApiKey(apiKey)) {
      return c.json({ error: "UNAUTHORIZED", message: "Invalid API key" }, 401);
    }

    const body = await c.req.json<{
      customer_id?: string;
      email: string;
      plan: "FREE" | "PRO";
      duration_days: number;
    }>();

    if (!body.email || !body.plan || !body.duration_days) {
      return c.json({ error: "INVALID_REQUEST", message: "Missing required fields" }, 400);
    }

    // Find or create customer
    let customer = findCustomerByEmail(body.email) as { id: string } | undefined;
    if (!customer) {
      const customerId = body.customer_id || uuid();
      createCustomer(customerId, body.email);
      customer = { id: customerId };
    }

    // Create license payload
    const now = new Date();
    const expiresAt = new Date(now.getTime() + body.duration_days * 24 * 60 * 60 * 1000);

    const payload: LicensePayload = {
      plan: body.plan,
      customer_id: customer.id,
      issued_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      offline_ttl_days: 30,
    };

    // Sign license
    const signedLicense = await signLicense(payload);

    // Store in database
    const licenseId = uuid();
    createLicense(licenseId, customer.id, body.plan, payload.issued_at, payload.expires_at);

    return c.json({ license: signedLicense });
  } catch (err) {
    console.error("[license/issue] Error:", err);
    return c.json({ error: "INTERNAL_ERROR", message: String(err) }, 500);
  }
});

/**
 * POST /v1/license/verify
 * Verify a license (optional - client can verify locally too)
 *
 * DESIGN PRINCIPLE:
 * - Local is truth (signature + expiration + TTL)
 * - Server provides supplementary info only:
 *   - revoked: boolean (server-side revocation check)
 *   - server_time: string (for clock sync)
 *   - policy_flags: object (feature flags, minimum version)
 *
 * Client should determine plan/expiration from local license data.
 */
app.post("/v1/license/verify", async (c) => {
  const body = await c.req.json<{ license: string }>();

  if (!body.license) {
    return c.json({ error: "INVALID_REQUEST", message: "Missing license" }, 400);
  }

  let license: SignedLicense;
  try {
    license = JSON.parse(Buffer.from(body.license, "base64").toString("utf-8"));
  } catch {
    return c.json({
      valid: false,
      reason: "INVALID_FORMAT",
      server_time: new Date().toISOString(),
    });
  }

  // Verify signature
  const validSignature = await verifyLicense(license);
  if (!validSignature) {
    return c.json({
      valid: false,
      reason: "INVALID_SIGNATURE",
      server_time: new Date().toISOString(),
    });
  }

  // Check server-side revocation
  const licenseId = license.customer_id; // Using customer_id as license identifier
  const revoked = isRevoked(licenseId);
  const revocationInfo = revoked ? getRevocationInfo(licenseId) : null;

  if (revoked) {
    return c.json({
      valid: false,
      reason: "REVOKED",
      revoked: true,
      revoked_at: revocationInfo?.revoked_at,
      revocation_reason: revocationInfo?.reason,
      server_time: new Date().toISOString(),
    });
  }

  // Return minimal response - client determines plan/expiration locally
  return c.json({
    valid: true,
    revoked: false,
    server_time: new Date().toISOString(),
    policy_flags: {
      minimum_version: process.env.MINIMUM_VERSION || "1.0.0",
      features_enabled: ["ant_lane", "scorecard", "policy_analysis", "auto_fix"],
      maintenance_mode: false,
    },
  });
});

function validateApiKey(key: string): boolean {
  // Simple validation - in production, check against stored keys
  return key.startsWith("vibe_sk_") && key.length > 20;
}

export default app;
