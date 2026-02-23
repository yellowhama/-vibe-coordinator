/**
 * Database layer (sql.js - pure JS SQLite)
 */

import initSqlJs, { Database } from "sql.js";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config.js";

let db: Database | null = null;
let SQL: initSqlJs.SqlJsStatic | null = null;

export async function initDb(): Promise<Database> {
  if (db) return db;

  // Initialize sql.js
  SQL = await initSqlJs();

  const dbPath = config.databaseUrl;

  // In-memory mode for Railway (stateless)
  if (dbPath === ":memory:") {
    console.log("[db] Using in-memory database");
    db = new SQL.Database();
    initSchema();
    return db;
  }

  // File-based for local development
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  initSchema();
  return db;
}

export function getDb(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function saveDb(): void {
  if (!db) return;
  // Don't save for in-memory database
  if (config.databaseUrl === ":memory:") return;

  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.databaseUrl, buffer);
}

function initSchema(): void {
  const d = getDb();

  d.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      stripe_customer_id TEXT,
      paddle_customer_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.run(`
    CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      plan TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      payment_provider TEXT DEFAULT 'stripe',
      external_transaction_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.run(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      date TEXT NOT NULL,
      plan TEXT NOT NULL,
      event_type TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (date, plan, event_type)
    )
  `);

  d.run(`CREATE INDEX IF NOT EXISTS idx_licenses_customer ON licenses(customer_id)`);
  d.run(`CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_daily(date)`);

  // Auth tables
  d.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      name TEXT,
      avatar_url TEXT,
      auth_provider TEXT NOT NULL,
      oauth_provider_id TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  d.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  d.run(`CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(auth_provider, oauth_provider_id)`);

  d.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_code TEXT,
      device_name TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  d.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);
  d.run(`CREATE INDEX IF NOT EXISTS idx_sessions_device_code ON sessions(device_code)`);

  d.run(`
    CREATE TABLE IF NOT EXISTS pending_oauth (
      device_code TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      state TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  d.run(`CREATE INDEX IF NOT EXISTS idx_pending_oauth_state ON pending_oauth(state)`);

  // Migration: add is_admin column if missing (existing DBs)
  try {
    d.run("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — ignore
  }

  // Seed admin accounts
  seedAdmins();

  saveDb();
}

function seedAdmins(): void {
  const d = getDb();

  const admins: Array<{ id: string; email: string; name: string; authProvider: string }> = [
    { id: "admin-hugh", email: "hugh@yellowhama.com", name: "Hugh", authProvider: "google" },
  ];

  for (const admin of admins) {
    d.run(
      "INSERT OR IGNORE INTO users (id, email, password_hash, name, avatar_url, auth_provider, oauth_provider_id, is_admin) VALUES (?, ?, NULL, ?, NULL, ?, NULL, 1)",
      [admin.id, admin.email, admin.name, admin.authProvider]
    );
    // Ensure existing user is promoted to admin
    d.run("UPDATE users SET is_admin = 1 WHERE email = ?", [admin.email]);
  }
}

// Customer operations
export function findCustomerByEmail(email: string): Record<string, unknown> | undefined {
  const stmt = getDb().prepare("SELECT * FROM customers WHERE email = ?");
  stmt.bind([email]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function createCustomer(
  id: string,
  email: string,
  stripeCustomerId?: string,
  paddleCustomerId?: string
): void {
  getDb().run(
    "INSERT INTO customers (id, email, stripe_customer_id, paddle_customer_id) VALUES (?, ?, ?, ?)",
    [id, email, stripeCustomerId || null, paddleCustomerId || null]
  );
  saveDb();
}

export function findCustomerByStripeId(stripeCustomerId: string): Record<string, unknown> | undefined {
  const stmt = getDb().prepare("SELECT * FROM customers WHERE stripe_customer_id = ?");
  stmt.bind([stripeCustomerId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function findCustomerByPaddleId(paddleCustomerId: string): Record<string, unknown> | undefined {
  const stmt = getDb().prepare("SELECT * FROM customers WHERE paddle_customer_id = ?");
  stmt.bind([paddleCustomerId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function updateCustomerPaddleId(customerId: string, paddleCustomerId: string): void {
  getDb().run(
    "UPDATE customers SET paddle_customer_id = ? WHERE id = ?",
    [paddleCustomerId, customerId]
  );
  saveDb();
}

// License operations
export function createLicense(
  id: string,
  customerId: string,
  plan: string,
  issuedAt: string,
  expiresAt: string,
  paymentProvider: "stripe" | "paddle" = "stripe",
  externalTransactionId?: string
): void {
  getDb().run(
    "INSERT INTO licenses (id, customer_id, plan, issued_at, expires_at, payment_provider, external_transaction_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, customerId, plan, issuedAt, expiresAt, paymentProvider, externalTransactionId || null]
  );
  saveDb();
}

export function findLicenseByCustomer(customerId: string): Record<string, unknown> | undefined {
  const stmt = getDb().prepare(
    "SELECT * FROM licenses WHERE customer_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1"
  );
  stmt.bind([customerId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

// User operations
export function findUserByEmail(email: string): Record<string, unknown> | undefined {
  const stmt = getDb().prepare("SELECT * FROM users WHERE email = ?");
  stmt.bind([email]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function findUserById(id: string): Record<string, unknown> | undefined {
  const stmt = getDb().prepare("SELECT * FROM users WHERE id = ?");
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function findUserByOAuth(provider: string, oauthId: string): Record<string, unknown> | undefined {
  const stmt = getDb().prepare("SELECT * FROM users WHERE auth_provider = ? AND oauth_provider_id = ?");
  stmt.bind([provider, oauthId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function createUser(
  id: string,
  email: string,
  passwordHash: string | null,
  name: string | null,
  avatarUrl: string | null,
  authProvider: string,
  oauthProviderId: string | null
): void {
  getDb().run(
    "INSERT INTO users (id, email, password_hash, name, avatar_url, auth_provider, oauth_provider_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, email, passwordHash, name, avatarUrl, authProvider, oauthProviderId]
  );
  saveDb();
}

export function updateUser(id: string, fields: { name?: string; avatar_url?: string }): void {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  if (fields.name !== undefined) { sets.push("name = ?"); values.push(fields.name); }
  if (fields.avatar_url !== undefined) { sets.push("avatar_url = ?"); values.push(fields.avatar_url); }
  if (sets.length === 0) return;
  values.push(id);
  getDb().run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, values);
  saveDb();
}

// Session operations
export function createSessionRecord(
  id: string,
  userId: string,
  deviceCode: string | null,
  deviceName: string | null,
  expiresAt: string
): void {
  getDb().run(
    "INSERT INTO sessions (id, user_id, device_code, device_name, expires_at) VALUES (?, ?, ?, ?, ?)",
    [id, userId, deviceCode, deviceName, expiresAt]
  );
  saveDb();
}

export function findSessionById(id: string): Record<string, unknown> | undefined {
  const stmt = getDb().prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')");
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function findSessionByDeviceCode(deviceCode: string): Record<string, unknown> | undefined {
  const stmt = getDb().prepare("SELECT * FROM sessions WHERE device_code = ? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1");
  stmt.bind([deviceCode]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function deleteSession(id: string): void {
  getDb().run("DELETE FROM sessions WHERE id = ?", [id]);
  saveDb();
}

// Pending OAuth operations
export function createPendingOAuth(deviceCode: string, provider: string, state: string): void {
  getDb().run(
    "INSERT INTO pending_oauth (device_code, provider, state) VALUES (?, ?, ?)",
    [deviceCode, provider, state]
  );
  saveDb();
}

export function findPendingOAuthByState(state: string): Record<string, unknown> | undefined {
  const stmt = getDb().prepare("SELECT * FROM pending_oauth WHERE state = ?");
  stmt.bind([state]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function deletePendingOAuth(deviceCode: string): void {
  getDb().run("DELETE FROM pending_oauth WHERE device_code = ?", [deviceCode]);
  saveDb();
}

// Usage operations
export function incrementUsage(date: string, plan: string, eventType: string, count: number): void {
  getDb().run(
    `INSERT INTO usage_daily (date, plan, event_type, count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date, plan, event_type) DO UPDATE SET count = count + excluded.count`,
    [date, plan, eventType, count]
  );
  saveDb();
}
