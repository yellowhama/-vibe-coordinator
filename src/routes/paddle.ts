/**
 * Paddle webhook endpoint
 * =======================
 * Handles Paddle Billing webhooks for subscription management.
 *
 * Paddle events:
 * - transaction.completed: New purchase completed
 * - subscription.updated: Plan changed
 * - subscription.canceled: Subscription cancelled
 *
 * @see https://developer.paddle.com/webhooks/overview
 */

import { Hono } from "hono";
import * as crypto from "crypto";
import { config } from "../lib/config.js";
import {
  processPaymentEvent,
  type PaymentEvent,
} from "../lib/payment-gateway.js";

const app = new Hono();

/**
 * Paddle webhook event types
 */
interface PaddleWebhookEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: PaddleEventData;
}

interface PaddleEventData {
  id: string;
  status: string;
  customer_id: string;
  address_id?: string;
  business_id?: string;
  currency_code: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  first_billed_at?: string;
  next_billed_at?: string;
  paused_at?: string;
  canceled_at?: string;
  items?: PaddleItem[];
  billing_details?: {
    payment_terms?: {
      interval: string;
      frequency: number;
    };
  };
  custom_data?: Record<string, string>;
  // Transaction-specific
  invoice_id?: string;
  invoice_number?: string;
  // Subscription-specific
  current_billing_period?: {
    starts_at: string;
    ends_at: string;
  };
}

interface PaddleItem {
  status: string;
  quantity: number;
  price: {
    id: string;
    product_id: string;
    description: string;
    unit_price: {
      amount: string;
      currency_code: string;
    };
    billing_cycle?: {
      interval: string;
      frequency: number;
    };
  };
  product: {
    id: string;
    name: string;
    description?: string;
    custom_data?: Record<string, string>;
  };
}

/**
 * POST /v1/paddle/webhook
 * Handle Paddle webhook events
 */
app.post("/v1/paddle/webhook", async (c) => {
  const signature = c.req.header("paddle-signature");
  if (!signature) {
    return c.json({ error: "MISSING_SIGNATURE" }, 400);
  }

  const rawBody = await c.req.text();

  // Verify signature
  if (!verifyPaddleSignature(rawBody, signature, config.paddleWebhookSecret)) {
    console.error("[paddle] Webhook signature verification failed");
    return c.json({ error: "INVALID_SIGNATURE" }, 400);
  }

  let event: PaddleWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "INVALID_JSON" }, 400);
  }

  console.log(`[paddle] Received event: ${event.event_type} (${event.event_id})`);

  // Handle events
  switch (event.event_type) {
    case "transaction.completed":
      await handleTransactionCompleted(event);
      break;

    case "subscription.updated":
      await handleSubscriptionUpdated(event);
      break;

    case "subscription.canceled":
      await handleSubscriptionCanceled(event);
      break;

    case "subscription.paused":
      console.log(`[paddle] Subscription paused: ${event.data.id}`);
      // Could downgrade to FREE tier temporarily
      break;

    case "subscription.resumed":
      console.log(`[paddle] Subscription resumed: ${event.data.id}`);
      // Could restore PRO tier
      break;

    default:
      console.log(`[paddle] Unhandled event: ${event.event_type}`);
  }

  return c.json({ received: true });
});

/**
 * Handle transaction.completed
 * New purchase completed - issue license
 */
async function handleTransactionCompleted(event: PaddleWebhookEvent): Promise<void> {
  const data = event.data;
  console.log(`[paddle] Transaction completed: ${data.id}`);

  // Get customer email (would need to fetch from Paddle API in production)
  // For now, use custom_data if provided
  const email = data.custom_data?.email;
  if (!email) {
    console.error("[paddle] No email in transaction data");
    return;
  }

  // Determine plan from product
  const plan = determinePlanFromItems(data.items);

  // Calculate expiration from billing period
  let expiresAt: Date | undefined;
  if (data.current_billing_period?.ends_at) {
    expiresAt = new Date(data.current_billing_period.ends_at);
  }

  const paymentEvent: PaymentEvent = {
    provider: "paddle",
    eventType: "checkout_completed",
    email,
    plan,
    externalCustomerId: data.customer_id,
    externalTransactionId: data.id,
    expiresAt,
    metadata: data.custom_data,
  };

  await processPaymentEvent(paymentEvent);
}

/**
 * Handle subscription.updated
 * Plan changed
 */
async function handleSubscriptionUpdated(event: PaddleWebhookEvent): Promise<void> {
  const data = event.data;
  console.log(`[paddle] Subscription updated: ${data.id}`);

  const email = data.custom_data?.email;
  if (!email) {
    console.error("[paddle] No email in subscription data");
    return;
  }

  const plan = determinePlanFromItems(data.items);

  let expiresAt: Date | undefined;
  if (data.current_billing_period?.ends_at) {
    expiresAt = new Date(data.current_billing_period.ends_at);
  }

  const paymentEvent: PaymentEvent = {
    provider: "paddle",
    eventType: "subscription_updated",
    email,
    plan,
    externalCustomerId: data.customer_id,
    externalTransactionId: data.id,
    expiresAt,
    metadata: data.custom_data,
  };

  await processPaymentEvent(paymentEvent);
}

/**
 * Handle subscription.canceled
 * Subscription cancelled - revoke license
 */
async function handleSubscriptionCanceled(event: PaddleWebhookEvent): Promise<void> {
  const data = event.data;
  console.log(`[paddle] Subscription canceled: ${data.id}`);

  const email = data.custom_data?.email;
  if (!email) {
    console.error("[paddle] No email in subscription data");
    return;
  }

  const paymentEvent: PaymentEvent = {
    provider: "paddle",
    eventType: "subscription_cancelled",
    email,
    plan: "FREE", // Downgrade to free
    externalCustomerId: data.customer_id,
    externalTransactionId: data.id,
    metadata: data.custom_data,
  };

  await processPaymentEvent(paymentEvent);
}

/**
 * Determine plan from Paddle items
 */
function determinePlanFromItems(items?: PaddleItem[]): "FREE" | "PRO" {
  if (!items || items.length === 0) {
    return "FREE";
  }

  // Check product custom_data or name for plan info
  for (const item of items) {
    const planFromCustomData = item.product?.custom_data?.plan;
    if (planFromCustomData === "PRO" || planFromCustomData === "pro") {
      return "PRO";
    }

    const productName = item.product?.name?.toLowerCase() || "";
    if (productName.includes("pro") || productName.includes("premium")) {
      return "PRO";
    }
  }

  // Default to PRO for any paid subscription
  return "PRO";
}

/**
 * Verify Paddle webhook signature
 * @see https://developer.paddle.com/webhooks/signature-verification
 */
function verifyPaddleSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  if (!secret) {
    console.warn("[paddle] No webhook secret configured, skipping verification");
    return true;
  }

  try {
    // Paddle signature format: ts=TIMESTAMP;h1=SIGNATURE
    const parts = signature.split(";");
    const tsMatch = parts.find((p) => p.startsWith("ts="));
    const h1Match = parts.find((p) => p.startsWith("h1="));

    if (!tsMatch || !h1Match) {
      console.error("[paddle] Invalid signature format");
      return false;
    }

    const timestamp = tsMatch.slice(3);
    const expectedSignature = h1Match.slice(3);

    // Check timestamp (within 5 minutes)
    const eventTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - eventTime) > 300) {
      console.error("[paddle] Webhook timestamp too old");
      return false;
    }

    // Compute HMAC
    const signedPayload = `${timestamp}:${payload}`;
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(signedPayload);
    const computedSignature = hmac.digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(computedSignature)
    );
  } catch (err) {
    console.error("[paddle] Signature verification error:", err);
    return false;
  }
}

export default app;
