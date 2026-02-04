/**
 * Revocation List Manager
 * =======================
 * Simple file-based revocation list for license invalidation.
 *
 * Design decisions:
 * - File-based storage (survives process restart)
 * - Small footprint (only revoked license IDs)
 * - No full license data stored on server
 */

import * as fs from "fs";
import * as path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const REVOKED_FILE = path.join(DATA_DIR, "revoked_keys.json");

interface RevocationEntry {
  license_id: string;
  revoked_at: string;
  reason: string;
}

interface RevocationStore {
  entries: RevocationEntry[];
  last_updated: string;
}

/**
 * Ensure data directory exists
 */
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Load revocation list from file
 */
function loadRevocationStore(): RevocationStore {
  ensureDataDir();

  if (!fs.existsSync(REVOKED_FILE)) {
    return { entries: [], last_updated: new Date().toISOString() };
  }

  try {
    const raw = fs.readFileSync(REVOKED_FILE, "utf-8");
    return JSON.parse(raw) as RevocationStore;
  } catch {
    return { entries: [], last_updated: new Date().toISOString() };
  }
}

/**
 * Save revocation list to file
 */
function saveRevocationStore(store: RevocationStore): void {
  ensureDataDir();
  store.last_updated = new Date().toISOString();
  fs.writeFileSync(REVOKED_FILE, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Check if a license ID is revoked
 */
export function isRevoked(licenseId: string): boolean {
  const store = loadRevocationStore();
  return store.entries.some((e) => e.license_id === licenseId);
}

/**
 * Get revocation info for a license
 */
export function getRevocationInfo(licenseId: string): RevocationEntry | null {
  const store = loadRevocationStore();
  return store.entries.find((e) => e.license_id === licenseId) ?? null;
}

/**
 * Add a license to revocation list
 */
export function addRevocation(licenseId: string, reason: string): void {
  const store = loadRevocationStore();

  // Avoid duplicates
  if (store.entries.some((e) => e.license_id === licenseId)) {
    return;
  }

  store.entries.push({
    license_id: licenseId,
    revoked_at: new Date().toISOString(),
    reason,
  });

  saveRevocationStore(store);
  console.log(`[revocation] Added: ${licenseId} (${reason})`);
}

/**
 * Remove a license from revocation list (un-revoke)
 */
export function removeRevocation(licenseId: string): boolean {
  const store = loadRevocationStore();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.license_id !== licenseId);

  if (store.entries.length < before) {
    saveRevocationStore(store);
    console.log(`[revocation] Removed: ${licenseId}`);
    return true;
  }

  return false;
}

/**
 * Get all revoked license IDs
 */
export function listRevocations(): RevocationEntry[] {
  const store = loadRevocationStore();
  return store.entries;
}

/**
 * Get revocation count
 */
export function getRevocationCount(): number {
  const store = loadRevocationStore();
  return store.entries.length;
}
