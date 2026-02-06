/**
 * Stripe webhook endpoint
 */

import { Hono } from "hono";
import Stripe from "stripe";
import { v4 as uuid } from "uuid";
import { config } from "../lib/config.js";
import { signLicense, type LicensePayload } from "../lib/license.js";
import {
  createCustomer,
  findCustomerByEmail,
  createLicense,
  findLicenseByCustomer,
  findCustomerByStripeId,
  getDb,
  saveDb,
} from "../lib/db.js";
import { addRevocation } from "../lib/revocation.js";

const app = new Hono();

// Initialize Stripe (lazy)
let stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripe) {
    stripe = new Stripe(config.stripeSecretKey, { apiVersion: "2023-10-16" });
  }
  return stripe;
}

/**
 * POST /v1/stripe/webhook
 * Handle Stripe webhook events
 */
app.post("/v1/stripe/webhook", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "MISSING_SIGNATURE" }, 400);
  }

  const rawBody = await c.req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      config.stripeWebhookSecret
    );
  } catch (err) {
    console.error("[stripe] Webhook signature verification failed:", err);
    return c.json({ error: "INVALID_SIGNATURE" }, 400);
  }

  // Handle events
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      console.log(`[stripe] Checkout completed: ${session.id}`);
      await handleCheckoutCompleted(session);
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      console.log(`[stripe] Subscription updated: ${subscription.id}`);
      await handleSubscriptionUpdated(subscription);
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      console.log(`[stripe] Subscription deleted: ${subscription.id}`);
      await handleSubscriptionDeleted(subscription);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      console.log(`[stripe] Payment failed: ${invoice.id}`);
      handlePaymentFailed(invoice);
      break;
    }

    default:
      console.log(`[stripe] Unhandled event: ${event.type}`);
  }

  return c.json({ received: true });
});

/**
 * Handle checkout.session.completed
 * Issues a new license for the customer
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const email = session.customer_email || session.customer_details?.email;
  if (!email) {
    console.error("[stripe] No email in checkout session:", session.id);
    return;
  }

  // Determine plan from metadata or default to PRO
  const plan = (session.metadata?.plan as "FREE" | "PRO") || "PRO";
  const durationDays = parseInt(session.metadata?.duration_days || "365", 10);

  // Find or create customer
  let customer = findCustomerByEmail(email) as { id: string } | undefined;
  const stripeCustomerId = typeof session.customer === "string" ? session.customer : session.customer?.id;

  if (!customer) {
    const customerId = uuid();
    createCustomer(customerId, email, stripeCustomerId);
    customer = { id: customerId };
    console.log(`[stripe] Created customer: ${customerId} (${email})`);
  }

  // Create license payload
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

  const payload: LicensePayload = {
    plan,
    customer_id: customer.id,
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    offline_ttl_days: 30,
  };

  // Sign and store license
  const signedLicense = await signLicense(payload);
  const licenseId = uuid();
  createLicense(licenseId, customer.id, plan, payload.issued_at, payload.expires_at);

  console.log(`[stripe] Issued license: ${licenseId} for ${email} (${plan})`);

  // In production, you would send this license to the customer via email
  // For now, we just log it
  console.log(`[stripe] License payload (base64):`, Buffer.from(JSON.stringify(signedLicense)).toString("base64").substring(0, 50) + "...");
}

/**
 * Handle customer.subscription.updated
 * Updates the license if the plan changed
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const stripeCustomerId = typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer?.id;

  if (!stripeCustomerId) {
    console.error("[stripe] No customer ID in subscription:", subscription.id);
    return;
  }

  // Find customer by Stripe ID
  const customer = findCustomerByStripeId(stripeCustomerId) as { id: string; email: string } | undefined;

  if (!customer) {
    console.error("[stripe] Customer not found for Stripe ID:", stripeCustomerId);
    return;
  }

  // Determine new plan from subscription items
  const priceId = subscription.items.data[0]?.price?.id;
  const newPlan = determinePlanFromPriceId(priceId);

  // Check if customer already has a license with this plan
  const existingLicense = findLicenseByCustomer(customer.id) as { plan: string } | undefined;
  if (existingLicense && existingLicense.plan === newPlan) {
    console.log(`[stripe] Plan unchanged for ${customer.email}: ${newPlan}`);
    return;
  }

  // Create new license with updated plan
  const now = new Date();
  const periodEnd = new Date((subscription.current_period_end || 0) * 1000);

  const payload: LicensePayload = {
    plan: newPlan,
    customer_id: customer.id,
    issued_at: now.toISOString(),
    expires_at: periodEnd.toISOString(),
    offline_ttl_days: 30,
  };

  await signLicense(payload);
  const licenseId = uuid();
  createLicense(licenseId, customer.id, newPlan, payload.issued_at, payload.expires_at);

  console.log(`[stripe] Updated license to ${newPlan} for ${customer.email}`);
}

/**
 * Handle customer.subscription.deleted
 * Revokes the customer's license
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const stripeCustomerId = typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer?.id;

  if (!stripeCustomerId) {
    console.error("[stripe] No customer ID in subscription:", subscription.id);
    return;
  }

  // Find customer by Stripe ID
  const customer = findCustomerByStripeId(stripeCustomerId) as { id: string; email: string } | undefined;

  if (!customer) {
    console.error("[stripe] Customer not found for Stripe ID:", stripeCustomerId);
    return;
  }

  // Revoke the license
  addRevocation(customer.id, `Subscription cancelled: ${subscription.id}`);

  // Also mark license as revoked in database
  getDb().run(
    "UPDATE licenses SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL",
    [new Date().toISOString(), customer.id]
  );
  saveDb();

  console.log(`[stripe] Revoked license for ${customer.email} (subscription cancelled)`);
}

/**
 * Handle invoice.payment_failed
 * Logs the failure (doesn't immediately revoke)
 */
function handlePaymentFailed(invoice: Stripe.Invoice): void {
  const customerEmail = invoice.customer_email;
  const amountDue = invoice.amount_due / 100; // Convert from cents

  console.warn(`[stripe] Payment failed for ${customerEmail || "unknown"}`);
  console.warn(`[stripe] Amount due: $${amountDue.toFixed(2)}`);
  console.warn(`[stripe] Invoice ID: ${invoice.id}`);
  console.warn(`[stripe] Attempt count: ${invoice.attempt_count}`);

  // Note: Don't revoke immediately on payment failure
  // Stripe will retry and send customer.subscription.deleted if all retries fail
}

/**
 * Map Stripe price ID to plan
 * In production, this would be configured via environment or database
 */
function determinePlanFromPriceId(priceId: string | undefined): "FREE" | "PRO" {
  if (!priceId) return "FREE";

  // Check environment variable mapping
  const proPriceId = process.env.STRIPE_PRO_PRICE_ID;
  if (proPriceId && priceId === proPriceId) {
    return "PRO";
  }

  // Default logic: if it contains "pro" or "premium", it's PRO
  if (priceId.toLowerCase().includes("pro") || priceId.toLowerCase().includes("premium")) {
    return "PRO";
  }

  return "PRO"; // Default to PRO for paid subscriptions
}

export default app;
