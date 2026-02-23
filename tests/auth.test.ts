import { describe, it, expect, beforeEach } from "vitest";
import { initDb } from "../src/lib/db.js";
import {
  findUserByEmail,
  findUserById,
  createUser,
  findSessionByDeviceCode,
  createPendingOAuth,
  findPendingOAuthByState,
  deletePendingOAuth,
} from "../src/lib/db.js";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  createSession,
  validateSession,
  formatUser,
} from "../src/lib/auth.js";

// Force in-memory DB for tests
process.env.DATABASE_URL = ":memory:";

beforeEach(async () => {
  await initDb();
  // Clean test data (keep admin seed)
  const { getDb } = await import("../src/lib/db.js");
  const db = getDb();
  db.run("DELETE FROM pending_oauth");
  db.run("DELETE FROM sessions");
  db.run("DELETE FROM users WHERE id NOT LIKE 'admin-%'");
});

describe("Auth Library", () => {
  it("should hash and verify passwords", async () => {
    const hash = await hashPassword("testpass123");
    expect(hash).toBeTruthy();
    expect(hash).not.toBe("testpass123");

    const valid = await verifyPassword("testpass123", hash);
    expect(valid).toBe(true);

    const invalid = await verifyPassword("wrongpass", hash);
    expect(invalid).toBe(false);
  });

  it("should generate unique tokens", () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
    expect(t1).not.toBe(t2);
  });

  it("should create and validate sessions", () => {
    createUser("user-1", "test@test.com", null, "Test", null, "email", null);
    const { token } = createSession("user-1");

    const user = validateSession(token);
    expect(user).toBeTruthy();
    expect(user!.email).toBe("test@test.com");
  });

  it("should reject invalid session tokens", () => {
    const user = validateSession("nonexistent-token");
    expect(user).toBeNull();
  });

  it("should format user without sensitive fields", () => {
    const raw = {
      id: "u1",
      email: "a@b.com",
      password_hash: "secret",
      name: "Alice",
      avatar_url: null,
      auth_provider: "email",
      oauth_provider_id: null,
      created_at: "2026-01-01",
    };
    const formatted = formatUser(raw);
    expect(formatted).toEqual({
      id: "u1",
      email: "a@b.com",
      name: "Alice",
      avatar_url: null,
      auth_provider: "email",
      is_admin: false,
    });
    expect((formatted as Record<string, unknown>).password_hash).toBeUndefined();
  });
});

describe("User DB Operations", () => {
  it("should create and find user by email", () => {
    createUser("u1", "alice@test.com", "hash123", "Alice", null, "email", null);
    const user = findUserByEmail("alice@test.com");
    expect(user).toBeTruthy();
    expect(user!.name).toBe("Alice");
    expect(user!.auth_provider).toBe("email");
  });

  it("should find user by id", () => {
    createUser("u2", "bob@test.com", null, "Bob", null, "github", "gh-123");
    const user = findUserById("u2");
    expect(user).toBeTruthy();
    expect(user!.email).toBe("bob@test.com");
  });

  it("should return undefined for non-existent user", () => {
    expect(findUserByEmail("nobody@test.com")).toBeUndefined();
    expect(findUserById("no-such-id")).toBeUndefined();
  });
});

describe("Session DB Operations", () => {
  it("should create session with device_code and find by it", () => {
    createUser("u3", "carol@test.com", null, "Carol", null, "google", "g-456");
    createSession("u3", "dc-abc");

    const session = findSessionByDeviceCode("dc-abc");
    expect(session).toBeTruthy();
    expect(session!.user_id).toBe("u3");
  });

  it("should not find session for unknown device_code", () => {
    expect(findSessionByDeviceCode("unknown-dc")).toBeUndefined();
  });
});

describe("Pending OAuth DB Operations", () => {
  it("should create and find pending OAuth by state", () => {
    createPendingOAuth("dc-1", "google", "state-xyz");
    const pending = findPendingOAuthByState("state-xyz");
    expect(pending).toBeTruthy();
    expect(pending!.provider).toBe("google");
    expect(pending!.device_code).toBe("dc-1");
  });

  it("should delete pending OAuth", () => {
    createPendingOAuth("dc-2", "github", "state-abc");
    deletePendingOAuth("dc-2");
    expect(findPendingOAuthByState("state-abc")).toBeUndefined();
  });
});
