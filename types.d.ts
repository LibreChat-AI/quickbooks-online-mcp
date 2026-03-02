// Augment the generated Env interface with our secret bindings
interface Env {
  QUICKBOOKS_CLIENT_ID: string
  QUICKBOOKS_CLIENT_SECRET: string
  QUICKBOOKS_ENVIRONMENT: string // 'sandbox' | 'production'
}

type QBAuthContext = {
  accessToken: string
  refreshToken: string
  realmId: string
}
