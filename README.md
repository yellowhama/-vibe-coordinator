# Vibe Coordinator

Minimal coordination server for Vibe PM. Runs on Railway $5 plan.

## Philosophy

> **Coordinator = 안내 데스크, 연산은 0**

This server handles:
- License issue/verify
- Version check
- Usage tracking (anonymous)
- Stripe webhooks

This server does NOT handle:
- AI/model execution
- File scanning
- Scout/Bee/Ant execution
- Any computation

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/v1/version` | Client version info |
| POST | `/v1/license/issue` | Issue license (API key required) |
| POST | `/v1/license/verify` | Verify license |
| POST | `/v1/usage/ping` | Record anonymous usage |
| POST | `/v1/stripe/webhook` | Stripe events |

## Setup

### Local Development

```bash
# Install dependencies
npm install

# Create data directory
mkdir -p data

# Set environment variables
export LICENSE_PRIVATE_KEY="your_ed25519_private_key_hex"
export LICENSE_PUBLIC_KEY="your_ed25519_public_key_hex"
export STRIPE_SECRET_KEY="sk_test_..."
export STRIPE_WEBHOOK_SECRET="whsec_..."

# Run in development
npm run dev
```

### Railway Deployment

1. Connect this repo to Railway
2. Set environment variables in Railway dashboard
3. Deploy

### Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `PORT` | No | Server port (default: 3000) |
| `DATABASE_URL` | No | SQLite path (default: ./data/coordinator.db) |
| `LICENSE_PRIVATE_KEY` | Yes | Ed25519 private key (hex) |
| `LICENSE_PUBLIC_KEY` | Yes | Ed25519 public key (hex) |
| `STRIPE_SECRET_KEY` | Yes | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook secret |

## Generate License Keys

```bash
# Using Node.js
node -e "
const ed = require('@noble/ed25519');
const priv = ed.utils.randomPrivateKey();
const pub = ed.getPublicKeyAsync(priv).then(p => {
  console.log('Private:', Buffer.from(priv).toString('hex'));
  console.log('Public:', Buffer.from(p).toString('hex'));
});
"
```

## Fail-Safe Design

If this server is down:
- Local MCP server: **Works normally**
- bitnet-musu: **Works normally**
- Scout/Bee/Ant: **Works normally**
- License: Uses cached license (offline TTL: 30 days)
- Only broken: Login, payment, version check

## License

MIT
