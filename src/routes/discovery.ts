/**
 * Peer Discovery Endpoints
 * ========================
 * Manages peer registration and discovery for distributed storage.
 *
 * Endpoints:
 * - POST /v1/discovery/register - Register a peer
 * - GET /v1/discovery/peers - List active peers
 * - POST /v1/discovery/heartbeat - Keep-alive heartbeat
 * - DELETE /v1/discovery/unregister - Remove a peer
 */

import { Hono } from "hono";
import { v4 as uuid } from "uuid";

const app = new Hono();

/**
 * Peer information
 */
interface Peer {
  id: string;
  address: string;
  port: number;
  name: string;
  region?: string;
  capabilities: string[];
  registeredAt: Date;
  lastHeartbeat: Date;
  version: string;
}

/**
 * In-memory peer registry
 * In production, this would be backed by a database
 */
const peers: Map<string, Peer> = new Map();

/**
 * Heartbeat timeout (5 minutes)
 */
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Clean up stale peers periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [id, peer] of peers) {
    if (now - peer.lastHeartbeat.getTime() > HEARTBEAT_TIMEOUT_MS) {
      peers.delete(id);
      console.log(`[discovery] Removed stale peer: ${peer.name} (${id})`);
    }
  }
}, 60 * 1000); // Check every minute

/**
 * POST /v1/discovery/register
 * Register a new peer
 */
app.post("/v1/discovery/register", async (c) => {
  try {
    const body = await c.req.json<{
      address: string;
      port: number;
      name: string;
      region?: string;
      capabilities?: string[];
      version?: string;
    }>();

    if (!body.address || !body.port || !body.name) {
      return c.json(
        { error: "INVALID_REQUEST", message: "Missing required fields: address, port, name" },
        400
      );
    }

    // Check if peer already registered (by address:port)
    const existingPeer = Array.from(peers.values()).find(
      (p) => p.address === body.address && p.port === body.port
    );

    const peerId = existingPeer?.id || uuid();
    const now = new Date();

    const peer: Peer = {
      id: peerId,
      address: body.address,
      port: body.port,
      name: body.name,
      region: body.region,
      capabilities: body.capabilities || ["block_sync"],
      registeredAt: existingPeer?.registeredAt || now,
      lastHeartbeat: now,
      version: body.version || "1.0.0",
    };

    peers.set(peerId, peer);

    console.log(`[discovery] Registered peer: ${peer.name} at ${peer.address}:${peer.port}`);

    return c.json({
      peer_id: peerId,
      registered_at: peer.registeredAt.toISOString(),
      heartbeat_interval_ms: HEARTBEAT_TIMEOUT_MS / 2, // Recommend heartbeat at half timeout
    });
  } catch (err) {
    console.error("[discovery] Registration error:", err);
    return c.json({ error: "INTERNAL_ERROR", message: String(err) }, 500);
  }
});

/**
 * GET /v1/discovery/peers
 * List all active peers
 */
app.get("/v1/discovery/peers", (c) => {
  const region = c.req.query("region");
  const capability = c.req.query("capability");

  let activePeers = Array.from(peers.values());

  // Filter by region if specified
  if (region) {
    activePeers = activePeers.filter((p) => p.region === region);
  }

  // Filter by capability if specified
  if (capability) {
    activePeers = activePeers.filter((p) => p.capabilities.includes(capability));
  }

  return c.json({
    peers: activePeers.map((p) => ({
      id: p.id,
      address: p.address,
      port: p.port,
      name: p.name,
      region: p.region,
      capabilities: p.capabilities,
      version: p.version,
      last_heartbeat: p.lastHeartbeat.toISOString(),
    })),
    count: activePeers.length,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /v1/discovery/heartbeat
 * Update peer's last heartbeat
 */
app.post("/v1/discovery/heartbeat", async (c) => {
  try {
    const body = await c.req.json<{
      peer_id: string;
      status?: "healthy" | "degraded" | "unhealthy";
      load?: number; // 0-100 percentage
    }>();

    if (!body.peer_id) {
      return c.json({ error: "INVALID_REQUEST", message: "Missing peer_id" }, 400);
    }

    const peer = peers.get(body.peer_id);
    if (!peer) {
      return c.json({ error: "PEER_NOT_FOUND", message: "Peer not registered" }, 404);
    }

    peer.lastHeartbeat = new Date();
    peers.set(body.peer_id, peer);

    return c.json({
      ack: true,
      next_heartbeat_in_ms: HEARTBEAT_TIMEOUT_MS / 2,
      server_time: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[discovery] Heartbeat error:", err);
    return c.json({ error: "INTERNAL_ERROR", message: String(err) }, 500);
  }
});

/**
 * DELETE /v1/discovery/unregister
 * Remove a peer from the registry
 */
app.delete("/v1/discovery/unregister", async (c) => {
  try {
    const body = await c.req.json<{ peer_id: string }>();

    if (!body.peer_id) {
      return c.json({ error: "INVALID_REQUEST", message: "Missing peer_id" }, 400);
    }

    const peer = peers.get(body.peer_id);
    if (!peer) {
      return c.json({ error: "PEER_NOT_FOUND", message: "Peer not registered" }, 404);
    }

    peers.delete(body.peer_id);
    console.log(`[discovery] Unregistered peer: ${peer.name} (${body.peer_id})`);

    return c.json({
      unregistered: true,
      peer_id: body.peer_id,
    });
  } catch (err) {
    console.error("[discovery] Unregister error:", err);
    return c.json({ error: "INTERNAL_ERROR", message: String(err) }, 500);
  }
});

/**
 * GET /v1/discovery/peer/:id
 * Get specific peer info
 */
app.get("/v1/discovery/peer/:id", (c) => {
  const peerId = c.req.param("id");
  const peer = peers.get(peerId);

  if (!peer) {
    return c.json({ error: "PEER_NOT_FOUND", message: "Peer not registered" }, 404);
  }

  return c.json({
    id: peer.id,
    address: peer.address,
    port: peer.port,
    name: peer.name,
    region: peer.region,
    capabilities: peer.capabilities,
    version: peer.version,
    registered_at: peer.registeredAt.toISOString(),
    last_heartbeat: peer.lastHeartbeat.toISOString(),
  });
});

export default app;
