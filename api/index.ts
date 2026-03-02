import { QuickBooksMCP } from "./QuickBooksMCP.ts"
import {
  qbBearerTokenAuthMiddleware,
  getQBAuthEndpoint,
  exchangeCodeForToken,
  refreshAccessToken,
} from "./lib/qb-auth"
import { cors } from "hono/cors"
import { Hono } from "hono"

// Export the QuickBooksMCP class so the Worker runtime can find it
export { QuickBooksMCP }

// Store registered clients in memory (in production, use a database)
interface RegisteredClient {
  client_id: string
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  scope?: string
  token_endpoint_auth_method: string
  created_at: number
}
const registeredClients = new Map<string, RegisteredClient>()

export default new Hono<{ Bindings: Env }>()
  .use(cors())

  // OAuth Authorization Server Discovery
  .get("/.well-known/oauth-authorization-server", async (c) => {
    const url = new URL(c.req.url)
    return c.json({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/token`,
      registration_endpoint: `${url.origin}/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["com.intuit.quickbooks.accounting"],
    })
  })

  // Dynamic Client Registration endpoint
  .post("/register", async (c) => {
    const body = await c.req.json()

    const clientId = crypto.randomUUID()

    registeredClients.set(clientId, {
      client_id: clientId,
      client_name: body.client_name || "MCP Client",
      redirect_uris: body.redirect_uris || [],
      grant_types: body.grant_types || ["authorization_code", "refresh_token"],
      response_types: body.response_types || ["code"],
      scope: body.scope,
      token_endpoint_auth_method: "none",
      created_at: Date.now(),
    })

    return c.json(
      {
        client_id: clientId,
        client_name: body.client_name || "MCP Client",
        redirect_uris: body.redirect_uris || [],
        grant_types: body.grant_types || ["authorization_code", "refresh_token"],
        response_types: body.response_types || ["code"],
        scope: body.scope,
        token_endpoint_auth_method: "none",
      },
      201
    )
  })

  // Authorization endpoint - redirects to Intuit
  .get("/authorize", async (c) => {
    const url = new URL(c.req.url)
    const intuitAuthUrl = new URL(getQBAuthEndpoint("authorize"))

    // Copy all query parameters except client_id
    url.searchParams.forEach((value, key) => {
      if (key !== "client_id") {
        intuitAuthUrl.searchParams.set(key, value)
      }
    })

    // Use our QuickBooks app's client_id
    intuitAuthUrl.searchParams.set("client_id", c.env.QUICKBOOKS_CLIENT_ID)

    // Ensure QB accounting scope is requested
    if (!intuitAuthUrl.searchParams.has("scope")) {
      intuitAuthUrl.searchParams.set("scope", "com.intuit.quickbooks.accounting")
    }

    return c.redirect(intuitAuthUrl.toString())
  })

  // Token exchange endpoint
  .post("/token", async (c) => {
    const body = await c.req.parseBody()

    if (body.grant_type === "authorization_code") {
      const result = await exchangeCodeForToken(
        body.code as string,
        body.redirect_uri as string,
        c.env.QUICKBOOKS_CLIENT_ID,
        c.env.QUICKBOOKS_CLIENT_SECRET,
        body.code_verifier as string | undefined
      )
      return c.json(result)
    } else if (body.grant_type === "refresh_token") {
      const result = await refreshAccessToken(
        body.refresh_token as string,
        c.env.QUICKBOOKS_CLIENT_ID,
        c.env.QUICKBOOKS_CLIENT_SECRET
      )
      return c.json(result)
    }

    return c.json({ error: "unsupported_grant_type" }, 400)
  })

  // QuickBooks MCP endpoints
  .use("/sse/*", qbBearerTokenAuthMiddleware)
  .route(
    "/sse",
    new Hono().mount(
      "/",
      QuickBooksMCP.serveSSE("/sse", { binding: "QB_MCP_OBJECT" }).fetch
    )
  )

  .use("/mcp", qbBearerTokenAuthMiddleware)
  .route(
    "/mcp",
    new Hono().mount(
      "/",
      QuickBooksMCP.serve("/mcp", { binding: "QB_MCP_OBJECT" }).fetch
    )
  )

  // Health check endpoint
  .get("/", (c) => c.text("QuickBooks Online MCP Server is running"))

  .get("/terms", (c) => c.html(`<!DOCTYPE html><html><head><title>Terms of Service</title></head><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 20px"><h1>Terms of Service</h1><p>This QuickBooks Online MCP Server is provided as-is for integrating QuickBooks Online data with MCP-compatible clients.</p><p>By using this service, you agree to comply with <a href="https://developer.intuit.com/app/developer/qbo/docs/develop/rest-api-features/api-policy">Intuit's API Terms of Service</a> and use the QuickBooks API responsibly.</p><p>This service acts as an OAuth proxy and does not store any QuickBooks financial data.</p></body></html>`))

  .get("/privacy", (c) => c.html(`<!DOCTYPE html><html><head><title>Privacy Policy</title></head><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 20px"><h1>Privacy Policy</h1><p>This QuickBooks Online MCP Server processes QuickBooks Online data on behalf of authenticated users via OAuth 2.0.</p><p><strong>Data collected:</strong> OAuth access tokens and refresh tokens are used transiently to authenticate API requests. No QuickBooks financial data is stored by this service.</p><p><strong>Data sharing:</strong> Data is only exchanged between the authenticated MCP client and the QuickBooks Online API. No data is shared with third parties.</p><p><strong>Security:</strong> All communication uses HTTPS. OAuth credentials are stored as encrypted secrets.</p></body></html>`))
