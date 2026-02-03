/**
 * Database layer (SQLite)
 */

import Database from "better-sqlite3";
import { config } from "./config.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.databaseUrl);
    db.pragma("journal_mode = WAL");
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      stripe_customer_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY,
      customer_id TEXT REFERENCES customers(id),
      plan TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_daily (
      date TEXT NOT NULL,
      plan TEXT NOT NULL,
      event_type TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (date, plan, event_type)
    );

    CREATE INDEX IF NOT EXISTS idx_licenses_customer ON licenses(customer_id);
    CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_daily(date);
  `);
}

// Customer operations
export function findCustomerByEmail(email: string) {
  return getDb().prepare("SELECT * FROM customers WHERE email = ?").get(email);
}

export function createCustomer(id: string, email: string, stripeCustomerId?: string) {
  getDb()
    .prepare("INSERT INTO customers (id, email, stripe_customer_id) VALUES (?, ?, ?)")
    .run(id, email, stripeCustomerId || null);
}

// License operations
export function createLicense(
  id: string,
  customerId: string,
  plan: string,
  issuedAt: string,
  expiresAt: string
) {
  getDb()
    .prepare(
      "INSERT INTO licenses (id, customer_id, plan, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, customerId, plan, issuedAt, expiresAt);
}

export function findLicenseByCustomer(customerId: string) {
  return getDb()
    .prepare("SELECT * FROM licenses WHERE customer_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(customerId);
}

// Usage operations
export function incrementUsage(date: string, plan: string, eventType: string, count: number) {
  getDb()
    .prepare(`
      INSERT INTO usage_daily (date, plan, event_type, count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(date, plan, event_type) DO UPDATE SET count = count + excluded.count
    `)
    .run(date, plan, eventType, count);
}
