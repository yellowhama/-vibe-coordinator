/**
 * Payment Gateway
 * ===============
 * Unified payment event processing for Stripe and Paddle.
 *
 * Design:
 * - Provider-agnostic event format
 * - Single entry point for all payment events
 * - Handles license lifecycle (issue, update, revoke)
 */

import { v4 as uuid } from "uuid";
import { signLicense, type LicensePayload } from "./license.js";
import {
  createCustomer,
  findCustomerByEmail,
  createLicense,
  findLicenseByCustomer,
  getDb,
  saveDb,
} from "./db.js";
import { addRevocation } from "./revocation.js";

/**
 * Payment provider type
 */
export type PaymentProvider = "stripe" | "paddle";

/**
 * Unified payment event type
 */
export type PaymentEventType =
  | "checkout_completed"
  | "subscription_updated"
  | "subscription_cancelled"
  | "payment_failed";

/**
 * Unified payment event
 */
export interface PaymentEvent {
  provider: PaymentProvider;
  eventType: PaymentEventType;
  email: string;
  plan: "FREE" | "PRO";
  externalCustomerId: string;
  externalTransactionId: string;
  expiresAt?: Date;
  metadata?: Record<string, string>;
}

/**
 * Result of processing a payment event
 */
export interface PaymentResult {
  success: boolean;
  customerId?: string;
  licenseId?: string;
  error?: string;
}

/**
 * Process a unified payment event
 */
export async function processPaymentEvent(event: PaymentEvent): Promise<PaymentResult> {
  console.log(`[payment] Processing ${event.provider}:${event.eventType} for ${event.email}`);

  try {
    switch (event.eventType) {
      case "checkout_completed":
        return await handleCheckoutCompleted(event);

      case "subscription_updated":
        return await handleSubscriptionUpdated(event);

      case "subscription_cancelled":
        return await handleSubscriptionCancelled(event);

      case "payment_failed":
        return handlePaymentFailed(event);

      default:
        return { success: false, error: `Unknown event type: ${event.eventType}` };
    }
  } catch (err) {
    console.error(`[payment] Error processing event:`, err);
    return { success: false, error: String(err) };
  }
}

/**
 * Handle checkout completed - issue new license
 */
async function handleCheckoutCompleted(event: PaymentEvent): Promise<PaymentResult> {
  // Find or create customer
  let customer = findCustomerByEmail(event.email) as { id: string } | undefined;

  if (!customer) {
    const customerId = uuid();
    const stripeId = event.provider === "stripe" ? event.externalCustomerId : undefined;
    const paddleId = event.provider === "paddle" ? event.externalCustomerId : undefined;
    createCustomer(customerId, event.email, stripeId, paddleId);
    customer = { id: customerId };
    console.log(`[payment] Created customer: ${customerId} (${event.email})`);
  }

  // Calculate expiration
  const now = new Date();
  const expiresAt = event.expiresAt || new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  // Create license payload
  const payload: LicensePayload = {
    plan: event.plan,
    customer_id: customer.id,
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    offline_ttl_days: 30,
  };

  // Sign and store license
  await signLicense(payload);
  const licenseId = uuid();
  createLicense(
    licenseId,
    customer.id,
    event.plan,
    payload.issued_at,
    payload.expires_at,
    event.provider,
    event.externalTransactionId
  );

  console.log(`[payment] Issued license: ${licenseId} for ${event.email} (${event.plan})`);

  return {
    success: true,
    customerId: customer.id,
    licenseId,
  };
}

/**
 * Handle subscription updated - update license plan
 */
async function handleSubscriptionUpdated(event: PaymentEvent): Promise<PaymentResult> {
  // Find customer by email
  const customer = findCustomerByEmail(event.email) as { id: string } | undefined;

  if (!customer) {
    console.error(`[payment] Customer not found: ${event.email}`);
    return { success: false, error: "Customer not found" };
  }

  // Check if plan changed
  const existingLicense = findLicenseByCustomer(customer.id) as { plan: string } | undefined;
  if (existingLicense && existingLicense.plan === event.plan) {
    console.log(`[payment] Plan unchanged for ${event.email}: ${event.plan}`);
    return { success: true, customerId: customer.id };
  }

  // Create new license with updated plan
  const now = new Date();
  const expiresAt = event.expiresAt || new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const payload: LicensePayload = {
    plan: event.plan,
    customer_id: customer.id,
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    offline_ttl_days: 30,
  };

  await signLicense(payload);
  const licenseId = uuid();
  createLicense(
    licenseId,
    customer.id,
    event.plan,
    payload.issued_at,
    payload.expires_at,
    event.provider,
    event.externalTransactionId
  );

  console.log(`[payment] Updated license to ${event.plan} for ${event.email}`);

  return {
    success: true,
    customerId: customer.id,
    licenseId,
  };
}

/**
 * Handle subscription cancelled - revoke license
 */
async function handleSubscriptionCancelled(event: PaymentEvent): Promise<PaymentResult> {
  // Find customer by email
  const customer = findCustomerByEmail(event.email) as { id: string } | undefined;

  if (!customer) {
    console.error(`[payment] Customer not found: ${event.email}`);
    return { success: false, error: "Customer not found" };
  }

  // Revoke the license
  addRevocation(customer.id, `Subscription cancelled via ${event.provider}`);

  // Mark license as revoked in database
  getDb().run(
    "UPDATE licenses SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL",
    [new Date().toISOString(), customer.id]
  );
  saveDb();

  console.log(`[payment] Revoked license for ${event.email} (subscription cancelled)`);

  return {
    success: true,
    customerId: customer.id,
  };
}

/**
 * Handle payment failed - log only, don't revoke
 */
function handlePaymentFailed(event: PaymentEvent): PaymentResult {
  console.warn(`[payment] Payment failed for ${event.email} via ${event.provider}`);
  console.warn(`[payment] Transaction: ${event.externalTransactionId}`);

  // Don't revoke on payment failure - provider will handle retries
  // and send subscription_cancelled if all retries fail

  return { success: true };
}

/**
 * Validate webhook signature (provider-specific)
 */
export function validateWebhookSignature(
  provider: PaymentProvider,
  payload: string,
  signature: string,
  secret: string
): boolean {
  // This is a placeholder - actual implementation depends on provider
  // Stripe uses stripe.webhooks.constructEvent()
  // Paddle uses its own signature verification
  console.log(`[payment] Validating ${provider} signature`);
  return true; // Placeholder
}
