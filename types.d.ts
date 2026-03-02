// Augment the generated Env interface with our secret bindings
interface Env {
  QUICKBOOKS_CLIENT_ID: string
  QUICKBOOKS_CLIENT_SECRET: string
  QUICKBOOKS_REALM_ID?: string // Optional — can be passed via X-QB-Realm-Id header instead
  QUICKBOOKS_ENVIRONMENT?: string // Optional — can be passed via X-QB-Environment header; defaults to 'sandbox'
}

type QBAuthContext = {
  accessToken: string
  refreshToken: string
  realmId: string
  environment: string // 'sandbox' | 'production'
}
