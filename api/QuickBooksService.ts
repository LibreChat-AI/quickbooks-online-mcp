/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Fetch-based QuickBooks Online API client.
 * Replaces both `node-quickbooks` and `intuit-oauth` with pure fetch() calls.
 *
 * QB API pattern: https://{sandbox-}quickbooks.api.intuit.com/v3/company/{realmId}/{entity}
 */
export class QuickBooksService {
  private env: Env
  private accessToken: string
  private refreshToken: string
  private realmId: string
  private environment: string

  constructor(env: Env, accessToken: string, realmId: string, environment: string, refreshToken = "") {
    this.env = env
    this.accessToken = accessToken
    this.refreshToken = refreshToken
    this.realmId = realmId
    this.environment = environment
  }

  private get baseUrl(): string {
    const prefix = this.environment.toLowerCase() === "production" ? "" : "sandbox-"
    return `https://${prefix}quickbooks.api.intuit.com/v3/company/${this.realmId}`
  }

  /**
   * Make an authenticated request to the QB API.
   * Automatically retries once on 401 after refreshing the access token.
   */
  private async makeRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`

    console.log(`[QB API] ${options.method || "GET"} ${url}`)

    const doFetch = (token: string) =>
      fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
      })

    let response = await doFetch(this.accessToken)

    if (response.status === 401) {
      console.log("[QB API] 401 received, attempting token refresh...")
      await this.refreshAccessToken()
      response = await doFetch(this.accessToken)
    }

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`QuickBooks API error ${response.status}: ${errorBody}`)
    }

    return response.json()
  }

  /**
   * Refresh the access token using the client credentials and the stored refresh token.
   * Called automatically on 401 responses.
   */
  private async refreshAccessToken(): Promise<void> {
    const tokenUrl = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"

    // We need a refresh token to refresh. If we don't have one stored,
    // we can't refresh — the 401 will propagate and LibreChat will
    // handle re-authentication at the OAuth layer.
    if (!this.refreshToken) {
      console.log("[QB API] No refresh token available, cannot refresh")
      return
    }

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${this.env.QUICKBOOKS_CLIENT_ID}:${this.env.QUICKBOOKS_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
      }),
    })

    if (!response.ok) {
      console.log(`[QB API] Token refresh failed: ${response.status}`)
      return
    }

    const data = (await response.json()) as {
      access_token: string
      refresh_token?: string
    }

    console.log("[QB API] Token refreshed successfully")
    this.accessToken = data.access_token
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token
    }
  }

  // ---------------------------------------------------------------------------
  // Generic CRUD — all QB entities share the same URL pattern
  // ---------------------------------------------------------------------------

  /**
   * Create an entity.
   * POST /v3/company/{realmId}/{entityName}
   */
  async create(entityName: string, data: Record<string, any>): Promise<any> {
    const result = await this.makeRequest(`/${entityName.toLowerCase()}`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return result[entityName] ?? result
  }

  /**
   * Read (get) an entity by ID.
   * GET /v3/company/{realmId}/{entityName}/{id}
   */
  async read(entityName: string, id: string): Promise<any> {
    const result = await this.makeRequest(`/${entityName.toLowerCase()}/${id}`)
    return result[entityName] ?? result
  }

  /**
   * Update an entity (full or sparse).
   * POST /v3/company/{realmId}/{entityName}
   * (Same endpoint as create — QB distinguishes by the presence of Id + SyncToken)
   */
  async update(entityName: string, data: Record<string, any>): Promise<any> {
    const result = await this.makeRequest(`/${entityName.toLowerCase()}`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return result[entityName] ?? result
  }

  /**
   * Delete an entity.
   * POST /v3/company/{realmId}/{entityName}?operation=delete
   */
  async delete(entityName: string, data: Record<string, any>): Promise<any> {
    const result = await this.makeRequest(`/${entityName.toLowerCase()}?operation=delete`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return result[entityName] ?? result
  }

  /**
   * Void a transaction (e.g. Invoice).
   * POST /v3/company/{realmId}/{entityName}?operation=void
   */
  async void(entityName: string, data: Record<string, any>): Promise<any> {
    const result = await this.makeRequest(`/${entityName.toLowerCase()}?operation=void`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    return result[entityName] ?? result
  }

  /**
   * Run a QB query (SQL-like syntax).
   * GET /v3/company/{realmId}/query?query=...
   *
   * Returns the array of entities from QueryResponse.
   */
  async query(queryString: string): Promise<any> {
    const encoded = encodeURIComponent(queryString)
    const result = await this.makeRequest(`/query?query=${encoded}`)
    const qr = result.QueryResponse
    if (!qr) return []
    // The QB API nests results under the entity name key, e.g. QueryResponse.Customer
    // Find the first array value in the response
    for (const key of Object.keys(qr)) {
      if (Array.isArray(qr[key])) return qr[key]
    }
    // count-only queries return { totalCount: N }
    if (qr.totalCount !== undefined) return qr.totalCount
    return []
  }

  // ---------------------------------------------------------------------------
  // Query builder helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a SQL-like query string from structured criteria.
   *
   * Supports:
   * - Array of { field, value, operator } objects
   * - Pagination (limit, offset)
   * - Sorting (asc, desc)
   * - Count-only (count)
   * - Fetch all (fetchAll)
   */
  buildQuery(
    entityName: string,
    options: {
      criteria?: Array<{ field: string; value: any; operator?: string }>
      limit?: number
      offset?: number
      asc?: string
      desc?: string
      count?: boolean
    } = {}
  ): string {
    const { criteria = [], limit, offset, asc, desc, count } = options

    const select = count ? `select count(*) from ${entityName}` : `select * from ${entityName}`

    const whereClauses: string[] = []
    for (const c of criteria) {
      const op = c.operator || "="
      const val = typeof c.value === "string" ? `'${c.value.replace(/'/g, "\\'")}'` : String(c.value)
      whereClauses.push(`${c.field} ${op} ${val}`)
    }

    let query = select
    if (whereClauses.length > 0) {
      query += ` where ${whereClauses.join(" and ")}`
    }
    if (asc) query += ` orderby ${asc} asc`
    if (desc) query += ` orderby ${desc} desc`
    if (limit) query += ` maxresults ${limit}`
    if (offset) query += ` startposition ${offset}`

    return query
  }

  /**
   * High-level search: builds query from structured options and executes it.
   * When fetchAll is true, paginates through all results (QB max 1000 per page).
   * When no limit is specified, defaults to QB's max of 1000 per request.
   */
  async search(
    entityName: string,
    options: {
      criteria?: Array<{ field: string; value: any; operator?: string }>
      limit?: number
      offset?: number
      asc?: string
      desc?: string
      count?: boolean
      fetchAll?: boolean
    } = {}
  ): Promise<any> {
    const { fetchAll, ...queryOpts } = options

    if (fetchAll) {
      // Paginate through all results, 1000 at a time
      const allResults: any[] = []
      let startPosition = 1
      const pageSize = 1000

      while (true) {
        const queryString = this.buildQuery(entityName, {
          ...queryOpts,
          limit: pageSize,
          offset: startPosition,
        })
        const page = await this.query(queryString)
        if (!Array.isArray(page) || page.length === 0) break
        allResults.push(...page)
        if (page.length < pageSize) break
        startPosition += pageSize
      }

      return allResults
    }

    const queryString = this.buildQuery(entityName, queryOpts)
    const results = await this.query(queryString)

    // If results hit the limit (or QB default of 100), add pagination hint
    if (Array.isArray(results)) {
      const effectiveLimit = queryOpts.limit || 100
      if (results.length >= effectiveLimit) {
        return {
          results,
          pagination: {
            returned: results.length,
            limit: effectiveLimit,
            offset: queryOpts.offset || 1,
            hasMore: true,
            hint: `Showing first ${results.length} results. Use offset=${(queryOpts.offset || 1) + effectiveLimit} to get the next page, or use count=true to get total count first.`,
          },
        }
      }
    }

    return results
  }

  /**
   * Sparse update helper: reads the current entity, merges patch on top, and updates.
   * This ensures required fields (e.g. VendorRef on Bill, AccountRef on Purchase)
   * are always present even if the caller only sends the fields they want to change.
   */
  async sparseUpdate(entityName: string, id: string, patch: Record<string, any>): Promise<any> {
    const current = await this.read(entityName, id)
    const merged = {
      ...current,
      ...patch,
      Id: current.Id,
      SyncToken: current.SyncToken,
      sparse: true,
    }
    return this.update(entityName, merged)
  }
}
