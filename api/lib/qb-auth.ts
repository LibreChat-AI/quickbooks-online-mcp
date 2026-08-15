import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import { protectedResourcePathFor, resourceMetadataUrl } from "./oauth-metadata"

/**
 * Builds the RFC 9728 §5.1 challenge. Without the `resource_metadata` pointer a
 * client sees a bare 401 and cannot discover which authorization server guards
 * this resource, so it silently gives up instead of starting the OAuth flow.
 */
function unauthorized(requestUrl: string): HTTPException {
  const { origin, pathname } = new URL(requestUrl)
  const metadataUrl = resourceMetadataUrl(origin, protectedResourcePathFor(pathname))

  return new HTTPException(401, {
    res: new Response("Missing or invalid access token", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="quickbooks-online-mcp", resource_metadata="${metadataUrl}"`,
        "Content-Type": "text/plain;charset=UTF-8",
      },
    }),
  })
}

/**
 * Middleware that extracts the Bearer access token and QB-specific headers,
 * then attaches them to the execution context as props for the McpAgent.
 *
 * The realm ID can come from either:
 * - X-QB-Realm-Id header (set via LibreChat customUserVars)
 * - QUICKBOOKS_REALM_ID env var (server-side fallback)
 *
 * Token refresh is handled by LibreChat's OAuth layer — it calls our /token
 * endpoint with grant_type=refresh_token when the access token expires.
 */
export const qbBearerTokenAuthMiddleware = createMiddleware<{
  Bindings: Env
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization")

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw unauthorized(c.req.url)
  }

  const accessToken = authHeader.substring(7)

  // Realm ID: prefer header (per-user via customUserVars), fall back to env var
  const realmId = c.req.header("X-QB-Realm-Id") || c.env.QUICKBOOKS_REALM_ID || ""

  // Environment: prefer header, fall back to env var, default to sandbox
  const environment = c.req.header("X-QB-Environment") || c.env.QUICKBOOKS_ENVIRONMENT || "sandbox"

  // Refresh token: optional header for service-layer auto-refresh on 401
  const refreshToken = c.req.header("X-QB-Refresh-Token") || ""

  console.log(`[QB Auth] realmId=${realmId} env=${environment} hasToken=${!!accessToken} hasRefresh=${!!refreshToken}`)

  if (!realmId) {
    throw new HTTPException(400, {
      message: "Missing QuickBooks Realm ID. Set X-QB-Realm-Id header or QUICKBOOKS_REALM_ID env var.",
    })
  }

  // @ts-ignore Props injected for McpAgent
  c.executionCtx.props = {
    accessToken,
    refreshToken,
    realmId,
    environment,
  }

  await next()
})

const INTUIT_AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2"
const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"

/**
 * Returns the Intuit OAuth endpoint URL for the given endpoint type.
 */
export function getQBAuthEndpoint(endpoint: "authorize" | "token"): string {
  if (endpoint === "authorize") return INTUIT_AUTH_BASE
  return INTUIT_TOKEN_URL
}

/**
 * Exchange an authorization code for access and refresh tokens.
 */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
  codeVerifier?: string
): Promise<{
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  x_refresh_token_expires_in: number
}> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  })

  if (codeVerifier) {
    params.append("code_verifier", codeVerifier)
  }

  const response = await fetch(INTUIT_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: params,
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to exchange code for token: ${error}`)
  }

  return response.json()
}

/**
 * Refresh an expired access token using a refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  x_refresh_token_expires_in?: number
}> {
  const response = await fetch(INTUIT_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to refresh token: ${error}`)
  }

  return response.json()
}
