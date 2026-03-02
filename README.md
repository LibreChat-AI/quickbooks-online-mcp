# QuickBooks Online MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for QuickBooks Online, built on Cloudflare Workers with OAuth 2.0 authentication.

Provides 50 tools for managing QuickBooks entities (customers, invoices, bills, vendors, etc.) via any MCP-compatible client.

## Architecture

- **Cloudflare Workers** runtime with Durable Objects for MCP state
- **Hono** for HTTP routing and OAuth proxy
- **McpAgent** (from `agents` package) for MCP transport (SSE + Streamable HTTP)
- **Pure `fetch()`** calls to the QuickBooks REST API — no Node.js SDKs required

```
api/
├── index.ts              # Hono app: OAuth discovery, /register, /authorize, /token, MCP routes
├── QuickBooksMCP.ts      # McpAgent Durable Object with all 50 tools
├── QuickBooksService.ts  # Fetch-based QB API client (generic CRUD + query builder)
└── lib/
    └── qb-auth.ts        # OAuth middleware and token exchange helpers
```

## Prerequisites

1. An [Intuit Developer](https://developer.intuit.com/) account
2. A QuickBooks app with OAuth 2.0 credentials (Client ID + Client Secret)
3. A connected QuickBooks company (sandbox or production)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

Copy the template and fill in your credentials:

```bash
cp .dev.vars.template .dev.vars
```

```env
QUICKBOOKS_CLIENT_ID=your_client_id
QUICKBOOKS_CLIENT_SECRET=your_client_secret
QUICKBOOKS_REALM_ID=your_company_id        # Optional if passed via header
QUICKBOOKS_ENVIRONMENT=sandbox              # 'sandbox' or 'production'
```

### 3. Configure redirect URI

In the [Intuit Developer Portal](https://developer.intuit.com/), add the appropriate redirect URI for your MCP client:

| MCP Client | Redirect URI |
|---|---|
| LibreChat (Docker) | `http://localhost:3080/api/mcp/quickbooks/oauth/callback` |
| LibreChat (local) | `http://localhost:3080/api/mcp/quickbooks/oauth/callback` |
| MCP Inspector | Use the callback URL shown in the Inspector UI |

### 4. Start the server

```bash
npx wrangler dev
```

The server starts at `http://localhost:3000`.

### 5. Verify

```bash
# Health check
curl http://localhost:3000/

# OAuth discovery
curl http://localhost:3000/.well-known/oauth-authorization-server
```

## MCP Client Configuration

### LibreChat

Add to your `librechat.yaml`:

```yaml
mcpServers:
  quickbooks:
    type: "streamable-http"
    url: "http://host.docker.internal:3000/mcp"  # Use localhost:3000 if not using Docker
    requiresOAuth: true
    headers:
      X-QB-Realm-Id: "{{QB_REALM_ID}}"
      X-QB-Environment: "{{QB_ENVIRONMENT}}"
    customUserVars:
      QB_REALM_ID:
        title: "QuickBooks Realm ID"
        description: "Your QuickBooks Company ID (found in Intuit Developer Portal)"
      QB_ENVIRONMENT:
        title: "QuickBooks Environment"
        description: "Enter 'sandbox' or 'production' (defaults to sandbox)"
```

### Other MCP Clients

Connect to `/mcp` (Streamable HTTP) or `/sse` (SSE) with:

- `Authorization: Bearer {access_token}` header (required)
- `X-QB-Realm-Id: {company_id}` header (required if not set in env)
- `X-QB-Environment: sandbox|production` header (optional, defaults to sandbox)
- `X-QB-Refresh-Token: {refresh_token}` header (optional, enables auto-refresh on 401)

## Finding Your Realm ID

The Realm ID is the QuickBooks **Company ID** of the company you want to access. This is **not** the same as your App ID or the developer account Company ID.

> **Common confusion:** The Intuit Developer Portal shows multiple IDs. Your app has a UUID App ID (e.g. `5ff5fa24-...`) and the app overview page shows a Company ID for your developer account. Neither of these is the Realm ID. The Realm ID is the Company ID of the **sandbox or production company with actual accounting data**.

**For sandbox:**
1. Go to [developer.intuit.com](https://developer.intuit.com) → your app → **Sandbox** tab
2. Under your sandbox company, the **Company ID** is the Realm ID (a numeric string like `9341456502676660`)

**For production:**
1. A real QuickBooks company must be connected to your app via OAuth
2. The Company ID is returned as the `realmId` query parameter in the OAuth callback URL
3. You can also find it in the QuickBooks Online URL when logged in: `https://app.qbo.intuit.com/app/homepage?company={realmId}`

## Available Tools (50)

| Entity | Create | Read/Get | Update | Delete | Search |
|---|---|---|---|---|---|
| **Customer** | `create_customer` | `get_customer` | `update_customer` | `delete_customer` | `search_customers` |
| **Invoice** | `create_invoice` | `read_invoice` | `update_invoice` | — | `search_invoices` |
| **Account** | `create_account` | — | `update_account` | — | `search_accounts` |
| **Item** | `create_item` | `read_item` | `update_item` | — | `search_items` |
| **Estimate** | `create_estimate` | `get_estimate` | `update_estimate` | `delete_estimate` | `search_estimates` |
| **Bill** | `create_bill` | `get_bill` | `update_bill` | `delete_bill` | `search_bills` |
| **Vendor** | `create_vendor` | `get_vendor` | `update_vendor` | `delete_vendor` | `search_vendors` |
| **Employee** | `create_employee` | `get_employee` | `update_employee` | — | `search_employees` |
| **Journal Entry** | `create_journal_entry` | `get_journal_entry` | `update_journal_entry` | `delete_journal_entry` | `search_journal_entries` |
| **Bill Payment** | `create_bill_payment` | `get_bill_payment` | `update_bill_payment` | `delete_bill_payment` | `search_bill_payments` |
| **Purchase** | `create_purchase` | `get_purchase` | `update_purchase` | `delete_purchase` | `search_purchases` |

### Search Tools

All search tools accept structured criteria with operators:

```json
{
  "criteria": [
    { "field": "DisplayName", "value": "Acme", "operator": "LIKE" },
    { "field": "Balance", "value": 0, "operator": ">" }
  ],
  "limit": 10,
  "asc": "DisplayName"
}
```

Supported operators: `=`, `<`, `>`, `<=`, `>=`, `LIKE`, `IN`

## Deployment

Deploy to Cloudflare Workers:

```bash
# Set secrets
npx wrangler secret put QUICKBOOKS_CLIENT_ID
npx wrangler secret put QUICKBOOKS_CLIENT_SECRET
npx wrangler secret put QUICKBOOKS_REALM_ID        # Optional
npx wrangler secret put QUICKBOOKS_ENVIRONMENT      # Optional

# Deploy
npx wrangler deploy
```

Update your MCP client's URL to point to the deployed worker URL.

## Sandbox vs Production

| | Sandbox | Production |
|---|---|---|
| API Base URL | `sandbox-quickbooks.api.intuit.com` | `quickbooks.api.intuit.com` |
| Data | Sample data from Intuit | Real company data |
| App Review | Not required | Required by Intuit |
| OAuth Keys | Sandbox keys from dev portal | Production keys (after app approval) |

Sandbox is the default. Set `QUICKBOOKS_ENVIRONMENT=production` or pass `X-QB-Environment: production` header to use production.

## License

MIT
