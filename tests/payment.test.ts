/**
 * Payment Gateway Tests
 * =====================
 * Tests for unified payment processing (Stripe + Paddle)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initDb,
  findCustomerByEmail,
  findLicenseByCustomer,
} from "../src/lib/db.js";
import { isRevoked } from "../src/lib/revocation.js";

// Mock the license module
vi.mock("../src/lib/license.js", () => ({
  signLicense: vi.fn().mockImplementation(async (payload) => ({
    ...payload,
    signature: "mock_signature_base64",
  })),
}));

// Import after mocking
import {
  processPaymentEvent,
  type PaymentEvent,
} from "../src/lib/payment-gateway.js";

// Set up in-memory database for tests
beforeEach(async () => {
  // Reset environment for in-memory database
  process.env.DATABASE_URL = ":memory:";
  await initDb();
});

afterEach(() => {
  // Clean up
  vi.clearAllMocks();
});

describe("Payment Gateway", () => {
  describe("checkout_completed", () => {
    it("should create customer and license for new checkout", async () => {
      const event: PaymentEvent = {
        provider: "stripe",
        eventType: "checkout_completed",
        email: "test@example.com",
        plan: "PRO",
        externalCustomerId: "cus_123",
        externalTransactionId: "cs_123",
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      };

      const result = await processPaymentEvent(event);

      expect(result.success).toBe(true);
      expect(result.customerId).toBeDefined();
      expect(result.licenseId).toBeDefined();

      // Verify customer was created
      const customer = findCustomerByEmail("test@example.com");
      expect(customer).toBeDefined();
      expect(customer?.email).toBe("test@example.com");
    });

    it("should reuse existing customer for same email", async () => {
      const event1: PaymentEvent = {
        provider: "stripe",
        eventType: "checkout_completed",
        email: "existing@example.com",
        plan: "PRO",
        externalCustomerId: "cus_111",
        externalTransactionId: "cs_111",
      };

      const event2: PaymentEvent = {
        provider: "paddle",
        eventType: "checkout_completed",
        email: "existing@example.com",
        plan: "PRO",
        externalCustomerId: "ctm_222",
        externalTransactionId: "txn_222",
      };

      const result1 = await processPaymentEvent(event1);
      const result2 = await processPaymentEvent(event2);

      expect(result1.customerId).toBe(result2.customerId);
    });

    it("should create license with correct payment provider", async () => {
      const event: PaymentEvent = {
        provider: "paddle",
        eventType: "checkout_completed",
        email: "paddle@example.com",
        plan: "PRO",
        externalCustomerId: "ctm_paddle",
        externalTransactionId: "txn_paddle",
      };

      const result = await processPaymentEvent(event);
      expect(result.success).toBe(true);

      // Verify license has correct provider
      const customer = findCustomerByEmail("paddle@example.com");
      const license = findLicenseByCustomer(customer?.id as string);
      expect(license?.payment_provider).toBe("paddle");
    });
  });

  describe("subscription_updated", () => {
    it("should update license when plan changes", async () => {
      // First, create initial checkout
      const checkoutEvent: PaymentEvent = {
        provider: "stripe",
        eventType: "checkout_completed",
        email: "upgrade@example.com",
        plan: "FREE",
        externalCustomerId: "cus_upgrade",
        externalTransactionId: "cs_initial",
      };
      await processPaymentEvent(checkoutEvent);

      // Now upgrade to PRO
      const updateEvent: PaymentEvent = {
        provider: "stripe",
        eventType: "subscription_updated",
        email: "upgrade@example.com",
        plan: "PRO",
        externalCustomerId: "cus_upgrade",
        externalTransactionId: "sub_upgrade",
      };

      const result = await processPaymentEvent(updateEvent);
      expect(result.success).toBe(true);
      // The update should have created a new license
      expect(result.licenseId).toBeDefined();
    });

    it("should not create new license if plan unchanged", async () => {
      // Create checkout
      const checkoutEvent: PaymentEvent = {
        provider: "stripe",
        eventType: "checkout_completed",
        email: "nochange@example.com",
        plan: "PRO",
        externalCustomerId: "cus_nochange",
        externalTransactionId: "cs_nochange",
      };
      await processPaymentEvent(checkoutEvent);

      // Update with same plan
      const updateEvent: PaymentEvent = {
        provider: "stripe",
        eventType: "subscription_updated",
        email: "nochange@example.com",
        plan: "PRO",
        externalCustomerId: "cus_nochange",
        externalTransactionId: "sub_nochange",
      };

      const result = await processPaymentEvent(updateEvent);
      expect(result.success).toBe(true);
      expect(result.licenseId).toBeUndefined(); // No new license created
    });
  });

  describe("subscription_cancelled", () => {
    it("should revoke license when subscription cancelled", async () => {
      // Create checkout first
      const checkoutEvent: PaymentEvent = {
        provider: "stripe",
        eventType: "checkout_completed",
        email: "cancel@example.com",
        plan: "PRO",
        externalCustomerId: "cus_cancel",
        externalTransactionId: "cs_cancel",
      };
      const checkoutResult = await processPaymentEvent(checkoutEvent);

      // Cancel subscription
      const cancelEvent: PaymentEvent = {
        provider: "stripe",
        eventType: "subscription_cancelled",
        email: "cancel@example.com",
        plan: "FREE",
        externalCustomerId: "cus_cancel",
        externalTransactionId: "sub_cancel",
      };

      const result = await processPaymentEvent(cancelEvent);
      expect(result.success).toBe(true);

      // Verify license is revoked
      expect(isRevoked(checkoutResult.customerId!)).toBe(true);
    });

    it("should handle cancellation for non-existent customer", async () => {
      const cancelEvent: PaymentEvent = {
        provider: "paddle",
        eventType: "subscription_cancelled",
        email: "nonexistent@example.com",
        plan: "FREE",
        externalCustomerId: "ctm_nonexistent",
        externalTransactionId: "txn_cancel",
      };

      const result = await processPaymentEvent(cancelEvent);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Customer not found");
    });
  });

  describe("payment_failed", () => {
    it("should not revoke license on payment failure", async () => {
      // Create checkout first
      const checkoutEvent: PaymentEvent = {
        provider: "stripe",
        eventType: "checkout_completed",
        email: "failure@example.com",
        plan: "PRO",
        externalCustomerId: "cus_failure",
        externalTransactionId: "cs_failure",
      };
      const checkoutResult = await processPaymentEvent(checkoutEvent);

      // Payment fails
      const failEvent: PaymentEvent = {
        provider: "stripe",
        eventType: "payment_failed",
        email: "failure@example.com",
        plan: "PRO",
        externalCustomerId: "cus_failure",
        externalTransactionId: "in_failed",
      };

      const result = await processPaymentEvent(failEvent);
      expect(result.success).toBe(true);

      // License should NOT be revoked
      expect(isRevoked(checkoutResult.customerId!)).toBe(false);
    });
  });
});

describe("Stripe Webhook Handler", () => {
  // Integration tests would go here with actual Stripe webhook payloads
  // For unit tests, we test the payment gateway directly
  it.skip("should verify Stripe webhook signature", () => {
    // Requires actual Stripe secret
  });
});

describe("Paddle Webhook Handler", () => {
  // Integration tests would go here with actual Paddle webhook payloads
  it.skip("should verify Paddle webhook signature", () => {
    // Requires actual Paddle secret
  });
});
