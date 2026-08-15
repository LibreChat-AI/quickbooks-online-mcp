/**
 * OAuth discovery metadata shared by the authorization-server document
 * (RFC 8414) and the protected-resource documents (RFC 9728).
 */

/** QuickBooks scopes this server requests, advertised by both discovery documents. */
export const QUICKBOOKS_SCOPES = ["com.intuit.quickbooks.accounting"] as const

/** Transport endpoints guarded by the bearer-token middleware. */
export const PROTECTED_RESOURCE_PATHS = ["/mcp", "/sse"] as const

export type ProtectedResourcePath = (typeof PROTECTED_RESOURCE_PATHS)[number]

export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported: string[]
  bearer_methods_supported: string[]
}

export function isProtectedResourcePath(path: string): path is ProtectedResourcePath {
  return (PROTECTED_RESOURCE_PATHS as readonly string[]).includes(path)
}

/**
 * Maps a request path onto the protected resource that guards it, so a request
 * to `/sse/message` still advertises `/sse` as the resource.
 */
export function protectedResourcePathFor(pathname: string): ProtectedResourcePath {
  return pathname === "/sse" || pathname.startsWith("/sse/") ? "/sse" : "/mcp"
}

/**
 * RFC 9728 §3.1 inserts the resource's path between the well-known segment and
 * the resource path, so `https://host/mcp` is described by
 * `https://host/.well-known/oauth-protected-resource/mcp`.
 */
export function resourceMetadataUrl(origin: string, resourcePath: string): string {
  return `${origin}/.well-known/oauth-protected-resource${resourcePath}`
}

export function buildProtectedResourceMetadata(
  origin: string,
  resourcePath: ProtectedResourcePath,
): ProtectedResourceMetadata {
  return {
    resource: `${origin}${resourcePath}`,
    authorization_servers: [origin],
    scopes_supported: [...QUICKBOOKS_SCOPES],
    bearer_methods_supported: ["header"],
  }
}
