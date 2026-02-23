/**
 * Auth routes — email register/login, OAuth, session management
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import {
  findUserByEmail,
  findUserById,
  findUserByOAuth,
  createUser,
  updateUser,
  findSessionByDeviceCode,
  deleteSession,
  createPendingOAuth,
  findPendingOAuthByState,
  deletePendingOAuth,
} from "../lib/db.js";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  createSession,
  formatUser,
  requireAuth,
} from "../lib/auth.js";
import { config } from "../lib/config.js";

type AuthEnv = {
  Variables: {
    user: Record<string, unknown>;
    sessionToken: string;
  };
};

const app = new Hono<AuthEnv>();

// ─── Email Registration ───────────────────────────────────────────

app.post("/auth/register", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const email = body.email as string | undefined;
  const password = body.password as string | undefined;
  const name = body.name as string | undefined;
  if (!email || !password) {
    return c.json({ error: "VALIDATION", message: "Email and password are required" }, 400);
  }

  if (password.length < 8) {
    return c.json({ error: "VALIDATION", message: "Password must be at least 8 characters" }, 400);
  }

  const emailLower = email.toLowerCase().trim();
  const existing = findUserByEmail(emailLower);
  if (existing) {
    return c.json({ error: "DUPLICATE", message: "Email already registered" }, 409);
  }

  const userId = uuidv4();
  const passwordHash = await hashPassword(password);
  createUser(userId, emailLower, passwordHash, name?.trim() || null, null, "email", null);

  const { token, expiresAt } = createSession(userId);
  const user = findUserById(userId)!;

  return c.json({
    access_token: token,
    expires_at: expiresAt,
    user: formatUser(user),
  });
});

// ─── Email Login ──────────────────────────────────────────────────

app.post("/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const email = body.email as string | undefined;
  const password = body.password as string | undefined;
  if (!email || !password) {
    return c.json({ error: "VALIDATION", message: "Email and password are required" }, 400);
  }

  const emailLower = email.toLowerCase().trim();
  const user = findUserByEmail(emailLower);
  if (!user) {
    return c.json({ error: "AUTH_FAILED", message: "Invalid email or password" }, 401);
  }

  if (!user.password_hash) {
    const provider = user.auth_provider as string;
    return c.json({
      error: "OAUTH_ACCOUNT",
      message: `This account uses ${provider} login. Please sign in with ${provider}.`,
    }, 400);
  }

  const valid = await verifyPassword(password, user.password_hash as string);
  if (!valid) {
    return c.json({ error: "AUTH_FAILED", message: "Invalid email or password" }, 401);
  }

  const { token, expiresAt } = createSession(user.id as string);

  return c.json({
    access_token: token,
    expires_at: expiresAt,
    user: formatUser(user),
  });
});

// ─── Current User ─────────────────────────────────────────────────

app.get("/auth/me", requireAuth, (c) => {
  const user = c.get("user") as Record<string, unknown>;
  return c.json({ user: formatUser(user) });
});

// ─── Logout ───────────────────────────────────────────────────────

app.post("/auth/logout", requireAuth, (c) => {
  const token = c.get("sessionToken") as string;
  deleteSession(token);
  return c.json({ success: true });
});

// ─── OAuth Initiate ───────────────────────────────────────────────

app.post("/auth/oauth/initiate", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const provider = body.provider as string | undefined;
  const device_code = body.device_code as string | undefined;
  if (!provider || !device_code) {
    return c.json({ error: "VALIDATION", message: "provider and device_code are required" }, 400);
  }

  if (provider !== "google" && provider !== "github") {
    return c.json({ error: "VALIDATION", message: "provider must be 'google' or 'github'" }, 400);
  }

  const state = generateToken();
  createPendingOAuth(device_code, provider, state);

  const callbackUrl = `${config.appUrl}/auth/oauth/callback`;
  let verificationUrl: string;

  if (provider === "google") {
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: callbackUrl,
      response_type: "code",
      scope: "email profile",
      state,
      access_type: "offline",
    });
    verificationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  } else {
    const params = new URLSearchParams({
      client_id: config.githubClientId,
      redirect_uri: callbackUrl,
      scope: "user:email",
      state,
    });
    verificationUrl = `https://github.com/login/oauth/authorize?${params}`;
  }

  return c.json({ verification_url: verificationUrl, device_code, state });
});

// ─── OAuth Callback (browser redirect target) ─────────────────────

app.get("/auth/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    return c.html(oauthResultPage(false, `Authentication denied: ${error}`));
  }

  if (!code || !state) {
    return c.html(oauthResultPage(false, "Missing code or state parameter"), 400);
  }

  // Find pending OAuth request
  const pending = findPendingOAuthByState(state);
  if (!pending) {
    return c.html(oauthResultPage(false, "Invalid or expired OAuth state"), 400);
  }

  const provider = pending.provider as string;
  const deviceCode = pending.device_code as string;

  try {
    let oauthUser: { email: string; name: string; avatar: string; providerId: string };

    if (provider === "google") {
      oauthUser = await exchangeGoogleCode(code);
    } else {
      oauthUser = await exchangeGithubCode(code);
    }

    // Upsert user
    let user = findUserByOAuth(provider, oauthUser.providerId);
    if (!user) {
      // Check if email already exists (link accounts)
      user = findUserByEmail(oauthUser.email.toLowerCase());
      if (user) {
        // Update existing user with OAuth info
        updateUser(user.id as string, { name: oauthUser.name, avatar_url: oauthUser.avatar });
      } else {
        const userId = uuidv4();
        createUser(
          userId,
          oauthUser.email.toLowerCase(),
          null,
          oauthUser.name,
          oauthUser.avatar,
          provider,
          oauthUser.providerId
        );
        user = findUserById(userId)!;
      }
    } else {
      // Update profile from OAuth provider
      updateUser(user.id as string, { name: oauthUser.name, avatar_url: oauthUser.avatar });
    }

    // Create session linked to device_code
    createSession(user.id as string, deviceCode);

    // Cleanup
    deletePendingOAuth(deviceCode);

    return c.html(oauthResultPage(true));
  } catch (err) {
    console.error(`[auth] OAuth ${provider} callback error:`, err);
    deletePendingOAuth(deviceCode);
    return c.html(oauthResultPage(false, "Authentication failed. Please try again."), 500);
  }
});

// ─── Session Poll (desktop polls after OAuth) ─────────────────────

app.post("/auth/session/poll", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const device_code = body.device_code as string | undefined;
  if (!device_code) {
    return c.json({ error: "VALIDATION", message: "device_code is required" }, 400);
  }

  const session = findSessionByDeviceCode(device_code);
  if (!session) {
    return c.json({ status: "pending" });
  }

  const user = findUserById(session.user_id as string);
  if (!user) {
    return c.json({ status: "pending" });
  }

  return c.json({
    status: "authenticated",
    access_token: session.id,
    expires_at: session.expires_at,
    user: formatUser(user),
  });
});

// ─── OAuth Token Exchange Helpers ─────────────────────────────────

async function exchangeGoogleCode(code: string): Promise<{
  email: string;
  name: string;
  avatar: string;
  providerId: string;
}> {
  // Exchange code for tokens
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: `${config.appUrl}/auth/oauth/callback`,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    throw new Error(`Google token exchange failed: ${text}`);
  }

  const tokens = (await tokenResp.json()) as { access_token: string };

  // Fetch user info
  const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userResp.ok) {
    throw new Error("Failed to fetch Google user info");
  }

  const info = (await userResp.json()) as {
    id: string;
    email: string;
    name: string;
    picture: string;
  };

  return {
    email: info.email,
    name: info.name || "",
    avatar: info.picture || "",
    providerId: info.id,
  };
}

async function exchangeGithubCode(code: string): Promise<{
  email: string;
  name: string;
  avatar: string;
  providerId: string;
}> {
  // Exchange code for token
  const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      code,
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      redirect_uri: `${config.appUrl}/auth/oauth/callback`,
    }),
  });

  if (!tokenResp.ok) {
    throw new Error("GitHub token exchange failed");
  }

  const tokenData = (await tokenResp.json()) as { access_token: string; error?: string };
  if (tokenData.error) {
    throw new Error(`GitHub OAuth error: ${tokenData.error}`);
  }

  // Fetch user info
  const userResp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!userResp.ok) {
    throw new Error("Failed to fetch GitHub user info");
  }

  const info = (await userResp.json()) as {
    id: number;
    login: string;
    name: string;
    avatar_url: string;
    email: string | null;
  };

  // Email might be private — fetch from /user/emails
  let email = info.email;
  if (!email) {
    const emailResp = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (emailResp.ok) {
      const emails = (await emailResp.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primary = emails.find((e) => e.primary && e.verified);
      email = primary?.email || emails[0]?.email || `${info.login}@github.noreply`;
    } else {
      email = `${info.login}@github.noreply`;
    }
  }

  return {
    email,
    name: info.name || info.login,
    avatar: info.avatar_url || "",
    providerId: String(info.id),
  };
}

// ─── OAuth Result HTML ────────────────────────────────────────────

function oauthResultPage(success: boolean, error?: string): string {
  if (success) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MUSU — Auth Complete</title></head>
<body style="background:#0B0B10;color:#F0F0F5;font-family:'Inter',sans-serif;
  display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center">
    <div style="font-size:48px;margin-bottom:16px">&#10003;</div>
    <h2 style="margin:0 0 8px;font-weight:600">Authentication Complete</h2>
    <p style="color:#9898A8;margin:0">Return to MUSU Desktop to continue.</p>
    <p style="color:#656578;font-size:12px;margin-top:24px">You can close this tab.</p>
  </div>
</body></html>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MUSU — Auth Failed</title></head>
<body style="background:#0B0B10;color:#F0F0F5;font-family:'Inter',sans-serif;
  display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center">
    <div style="font-size:48px;margin-bottom:16px;color:#EF4444">&#10007;</div>
    <h2 style="margin:0 0 8px;font-weight:600">Authentication Failed</h2>
    <p style="color:#EF4444;margin:0">${error || "An error occurred"}</p>
    <p style="color:#656578;font-size:12px;margin-top:24px">Please close this tab and try again.</p>
  </div>
</body></html>`;
}

export default app;
