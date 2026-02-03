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

  saveDb();
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

export function createCustomer(id: string, email: string, stripeCustomerId?: string): void {
  getDb().run(
    "INSERT INTO customers (id, email, stripe_customer_id) VALUES (?, ?, ?)",
    [id, email, stripeCustomerId || null]
  );
  saveDb();
}

// License operations
export function createLicense(
  id: string,
  customerId: string,
  plan: string,
  issuedAt: string,
  expiresAt: string
): void {
  getDb().run(
    "INSERT INTO licenses (id, customer_id, plan, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [id, customerId, plan, issuedAt, expiresAt]
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
