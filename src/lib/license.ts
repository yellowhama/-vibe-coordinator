/**
 * License signing and verification (Ed25519)
 */

import * as ed from "@noble/ed25519";
import { config } from "./config.js";

export interface LicensePayload {
  plan: "FREE" | "PRO";
  customer_id: string;
  issued_at: string;
  expires_at: string;
  offline_ttl_days: number;
}

export interface SignedLicense extends LicensePayload {
  signature: string;
}

/**
 * Sign a license payload
 */
export async function signLicense(payload: LicensePayload): Promise<SignedLicense> {
  const privateKey = hexToBytes(config.licensePrivateKey);
  const message = canonicalize(payload);
  const signature = await ed.signAsync(new TextEncoder().encode(message), privateKey);

  return {
    ...payload,
    signature: bytesToBase64(signature),
  };
}

/**
 * Verify a signed license
 */
export async function verifyLicense(license: SignedLicense): Promise<boolean> {
  try {
    const publicKey = hexToBytes(config.licensePublicKey);
    const { signature, ...payload } = license;
    const message = canonicalize(payload);
    const sig = base64ToBytes(signature);

    return await ed.verifyAsync(sig, new TextEncoder().encode(message), publicKey);
  } catch {
    return false;
  }
}

/**
 * Check if license is expired
 */
export function isLicenseExpired(license: SignedLicense): boolean {
  const expiresAt = new Date(license.expires_at);
  return expiresAt < new Date();
}

/**
 * Check if within offline TTL
 */
export function isWithinOfflineTTL(license: SignedLicense, lastVerified: Date): boolean {
  const ttlMs = license.offline_ttl_days * 24 * 60 * 60 * 1000;
  const deadline = new Date(lastVerified.getTime() + ttlMs);
  return new Date() < deadline;
}

// Helpers
function canonicalize(obj: object): string {
  // JCS-style canonical JSON
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}
