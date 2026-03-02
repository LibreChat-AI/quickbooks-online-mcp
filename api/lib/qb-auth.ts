import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"

/**
 * Middleware that extracts QB OAuth tokens and realm ID from request headers
 * and attaches them to the execution context as props for the McpAgent.
 */
export const qbBearerTokenAuthMiddleware = createMiddleware<{
  Bindings: Env
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization")

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Missing or invalid access token" })
  }

  const accessToken = authHeader.substring(7)
  const refreshToken = c.req.header("X-QB-Refresh-Token") || ""
  const realmId = c.req.header("X-QB-Realm-Id") || ""

  if (!realmId) {
    throw new HTTPException(400, { message: "Missing X-QB-Realm-Id header" })
  }

  // @ts-ignore Props injected for McpAgent
  c.executionCtx.props = {
    accessToken,
    refreshToken,
    realmId,
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
