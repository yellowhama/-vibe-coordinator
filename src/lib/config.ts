/**
 * Configuration from environment variables
 */

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),

  // Database — Railway Volume path or local file
  databaseUrl: process.env.DATABASE_URL || (process.env.RAILWAY_ENVIRONMENT ? "/data/coordinator.db" : "./data/coordinator.db"),

  // Stripe
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",

  // Paddle
  paddleWebhookSecret: process.env.PADDLE_WEBHOOK_SECRET || "",

  // License signing (Ed25519)
  licensePrivateKey: process.env.LICENSE_PRIVATE_KEY || "",
  licensePublicKey: process.env.LICENSE_PUBLIC_KEY || "",

  // OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  githubClientId: process.env.GITHUB_CLIENT_ID || "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || "",
  appUrl: process.env.APP_URL || "http://localhost:3000",

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
