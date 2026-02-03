/**
 * Stripe webhook endpoint
 */

import { Hono } from "hono";
import Stripe from "stripe";
import { config } from "../lib/config.js";

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
      // TODO: Trigger license issue
      // The license issue should be called with the customer email
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      console.log(`[stripe] Subscription updated: ${subscription.id}`);
      // TODO: Update license if plan changed
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      console.log(`[stripe] Subscription deleted: ${subscription.id}`);
      // TODO: Mark license as expired/revoked
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      console.log(`[stripe] Payment failed: ${invoice.id}`);
      // TODO: Notify user (optional)
      break;
    }

    default:
      console.log(`[stripe] Unhandled event: ${event.type}`);
  }

  return c.json({ received: true });
});

export default app;
