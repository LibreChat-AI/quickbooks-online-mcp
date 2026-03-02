# QuickBooks Online MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for QuickBooks Online, built on Cloudflare Workers with OAuth 2.0 authentication.

Provides 55 tools for managing QuickBooks entities (customers, invoices, bills, vendors, etc.) via any MCP-compatible client.

## Architecture

- **Cloudflare Workers** runtime with Durable Objects for MCP state
- **Hono** for HTTP routing and OAuth proxy
- **McpAgent** (from `agents` package) for MCP transport (SSE + Streamable HTTP)
- **Pure `fetch()`** calls to the QuickBooks REST API — no Node.js SDKs required

```
api/
├── index.ts              # Hono app: OAuth discovery, /register, /authorize, /token, MCP routes
├── QuickBooksMCP.ts      # McpAgent Durable Object with all tools
├── QuickBooksService.ts  # Fetch-based QB API client (generic CRUD + query builder)
└── lib/
    └── qb-auth.ts        # OAuth middleware and token exchange helpers
```

## Getting Your Intuit Developer Credentials

The Intuit Developer sandbox is **completely free** — no QuickBooks subscription needed for testing.

### Step 1: Create a Free Developer Account

1. Go to [developer.intuit.com](https://developer.intuit.com/) and sign up (no credit card required)
2. Once registered, Intuit automatically creates a **sandbox company** with sample data

### Step 2: Create an App

1. After logging in, go to **My Hub > App Dashboard**
2. Click **Create an app**
3. Select **QuickBooks Online and Payments**
4. Name it anything (e.g. "QBO MCP Server")
5. Select the **`com.intuit.quickbooks.accounting`** scope
6. Click **Create app**

### Step 3: Get Your Client ID and Client Secret

1. Inside your app, click **Keys & OAuth** in the left nav
2. Make sure you're on the **Development** tab (not Production)
3. Click **Show credentials**
4. Copy your **Client ID** and **Client Secret**

### Step 4: Add the Redirect URI

Still in **Keys & OAuth**:

1. Scroll to **Redirect URIs**
2. Click **Add URI**
3. Add the redirect URI for your MCP client (see table below)
4. Save

| MCP Client | Redirect URI |
|---|---|
| LibreChat (Docker or local) | `http://localhost:3080/api/mcp/quickbooks/oauth/callback` |
| MCP Inspector | Use the callback URL shown in the Inspector UI |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

Copy the template and fill in your credentials from the steps above:

```bash
cp .dev.vars.template .dev.vars
```

```env
QUICKBOOKS_CLIENT_ID=your_client_id
QUICKBOOKS_CLIENT_SECRET=your_client_secret
QUICKBOOKS_REALM_ID=your_company_id        # Optional if passed via header
QUICKBOOKS_ENVIRONMENT=sandbox              # 'sandbox' or 'production'
```

### 3. Start the server

```bash
npx wrangler dev
```

The server starts at `http://localhost:3000`.

### 4. Verify

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
        description: "Your QuickBooks Company ID (found in Intuit Developer Portal under Sandbox settings)"
      QB_ENVIRONMENT:
        title: "QuickBooks Environment"
        description: "Enter 'sandbox' or 'production' (defaults to sandbox)"
```

You must also add the server's address to `mcpSettings.allowedDomains` — LibreChat requires this for any local/non-public MCP server URL:

```yaml
mcpSettings:
  allowedDomains:
    - "http://localhost:3000"
```

When LibreChat starts, it will:
1. Detect the server needs OAuth and prompt you to authorize
2. Redirect you to Intuit's OAuth page
3. After authorizing, ask you for the **Realm ID** and **Environment** via the customUserVar prompts
4. Connect and expose all QuickBooks tools

### Other MCP Clients

Connect to `/mcp` (Streamable HTTP) or `/sse` (SSE) with:

- `Authorization: Bearer {access_token}` header (required)
- `X-QB-Realm-Id: {company_id}` header (required if not set in env)
- `X-QB-Environment: sandbox|production` header (optional, defaults to sandbox)
- `X-QB-Refresh-Token: {refresh_token}` header (optional, enables auto-refresh on 401)

## Finding Your Realm ID

The Realm ID is the QuickBooks **Company ID** of the company you want to access. This is **not** the same as your App ID or the developer account Company ID.

> **Common confusion:** The Intuit Developer Portal shows multiple IDs. Your app has a UUID App ID (e.g. `5ff5fa24-...`) and the app overview page shows a Company ID for your developer workspace. **Neither of these is the Realm ID.** The Realm ID is the Company ID of the **sandbox or production company with actual accounting data**.

**For sandbox:**
1. Go to [developer.intuit.com](https://developer.intuit.com) → your app → **Sandbox** tab
2. Under your sandbox company, the **Company ID** is the Realm ID (a numeric string like `9341456502676660`)

**For production:**
1. **Keyboard shortcut** (while logged into QBO): `Ctrl+Alt+?` (Windows) or `Control+Option+?` (Mac) — shows Company ID on screen
2. **Settings page**: Gear icon → Subscriptions and billing → Company ID is at the top
3. **OAuth callback**: Intuit includes `realmId` as a query parameter in the redirect URL

## Available Tools (55)

Full CRUD + search on all 11 QuickBooks entity types:

| Entity | Create | Read/Get | Update | Delete | Search |
|---|---|---|---|---|---|
| **Customer** | `create_customer` | `get_customer` | `update_customer` | `delete_customer` | `search_customers` |
| **Invoice** | `create_invoice` | `read_invoice` | `update_invoice` | `delete_invoice` | `search_invoices` |
| **Account** | `create_account` | `get_account` | `update_account` | `delete_account` | `search_accounts` |
| **Item** | `create_item` | `read_item` | `update_item` | `delete_item` | `search_items` |
| **Estimate** | `create_estimate` | `get_estimate` | `update_estimate` | `delete_estimate` | `search_estimates` |
| **Bill** | `create_bill` | `get_bill` | `update_bill` | `delete_bill` | `search_bills` |
| **Vendor** | `create_vendor` | `get_vendor` | `update_vendor` | `delete_vendor` | `search_vendors` |
| **Employee** | `create_employee` | `get_employee` | `update_employee` | `delete_employee` | `search_employees` |
| **Journal Entry** | `create_journal_entry` | `get_journal_entry` | `update_journal_entry` | `delete_journal_entry` | `search_journal_entries` |
| **Bill Payment** | `create_bill_payment` | `get_bill_payment` | `update_bill_payment` | `delete_bill_payment` | `search_bill_payments` |
| **Purchase** | `create_purchase` | `get_purchase` | `update_purchase` | `delete_purchase` | `search_purchases` |

> **Note:** Delete on Customer, Vendor, Employee, Account, and Item performs a **deactivation** (`Active: false`) since QuickBooks doesn't support hard deletion on these entities. Delete on Invoice performs a **void**. Delete on Bill, Estimate, Journal Entry, Bill Payment, and Purchase performs a hard delete.

### Tool Schemas

All create tools have **typed Zod schemas** matching the QuickBooks API spec — required fields are enforced, optional fields are documented with descriptions. This gives LLMs clear guidance on what to send. For example, `create_bill` requires `VendorRef` and `Line` items with proper `AccountBasedExpenseLineDetail` or `ItemBasedExpenseLineDetail` nesting.

All update tools **auto-fetch the current entity** to get `SyncToken` and required fields, so callers only need to provide the `Id` and the fields they want to change.

All delete tools only need the entity `id` — `SyncToken` is fetched automatically.

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
# Set your Cloudflare account ID (find it in the Cloudflare dashboard)
export CLOUDFLARE_ACCOUNT_ID=your_account_id

# Login to Cloudflare
npx wrangler login

# Set secrets (each prompts for the value)
npx wrangler secret put QUICKBOOKS_CLIENT_ID
npx wrangler secret put QUICKBOOKS_CLIENT_SECRET
npx wrangler secret put QUICKBOOKS_REALM_ID        # Optional if passed via header
npx wrangler secret put QUICKBOOKS_ENVIRONMENT      # 'sandbox' or 'production'

# Deploy
npx wrangler deploy
```

The deploy outputs your worker URL (e.g. `https://quickbooks-online-mcp-server.<subdomain>.workers.dev`). Update your MCP client config to point to this URL.

## Sandbox vs Production

| | Sandbox | Production |
|---|---|---|
| API Base URL | `sandbox-quickbooks.api.intuit.com` | `quickbooks.api.intuit.com` |
| Data | Sample data from Intuit | Real company data |
| Cost | Free (developer account only) | Requires QBO subscription (Simple Start+) |
| App Review | Not required | Required by Intuit |
| OAuth Keys | Development keys from dev portal | Production keys (after app approval) |

Sandbox is the default. Set `QUICKBOOKS_ENVIRONMENT=production` or pass `X-QB-Environment: production` header to use production.

## License

MIT
