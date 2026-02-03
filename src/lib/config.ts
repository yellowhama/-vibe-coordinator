/**
 * Configuration from environment variables
 */

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),

  // Database
  databaseUrl: process.env.DATABASE_URL || "./data/coordinator.db",

  // Stripe
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",

  // License signing (Ed25519)
  licensePrivateKey: process.env.LICENSE_PRIVATE_KEY || "",
  licensePublicKey: process.env.LICENSE_PUBLIC_KEY || "",

  // App info
  version: "0.1.0",
  latestClientVersion: "1.3.0",
  minimumClientVersion: "1.0.0",
};

export function validateConfig(): void {
  const required = ["STRIPE_SECRET_KEY", "LICENSE_PRIVATE_KEY", "LICENSE_PUBLIC_KEY"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0 && process.env.NODE_ENV === "production") {
    console.warn(`[config] Missing env vars: ${missing.join(", ")}`);
  }
}
