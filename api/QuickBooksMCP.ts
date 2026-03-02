/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpAgent } from "agents/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { QuickBooksService } from "./QuickBooksService.ts"
// QBAuthContext is declared globally in types.d.ts

// =============================================================================
// Shared Zod schemas matching QuickBooks Online API spec
// =============================================================================

/** Reference to another QB entity { value: "id", name: "display name" } */
const refSchema = z.object({
  value: z.string().describe("Entity ID"),
  name: z.string().optional().describe("Display name (optional, for readability)"),
}).describe("QuickBooks entity reference")

const addressSchema = z.object({
  Line1: z.string().optional(),
  Line2: z.string().optional(),
  Line3: z.string().optional(),
  City: z.string().optional(),
  Country: z.string().optional(),
  CountrySubDivisionCode: z.string().optional().describe("State/province code"),
  PostalCode: z.string().optional(),
}).describe("Physical/mailing address")

const phoneSchema = z.object({
  FreeFormNumber: z.string().describe("Phone number"),
}).describe("Phone number")

const emailSchema = z.object({
  Address: z.string().describe("Email address"),
}).describe("Email address")

/** Search options shared across all search tools */
const searchOptionsSchema = {
  criteria: z
    .array(
      z.object({
        field: z.string().describe("Entity field name to filter on"),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("Filter value"),
        operator: z
          .enum(["=", "<", ">", "<=", ">=", "LIKE", "IN"])
          .optional()
          .describe("Comparison operator. Defaults to '=' if omitted."),
      })
    )
    .optional()
    .describe("Filters to apply. Each entry is {field, value, operator?}."),
  limit: z.number().optional().describe("Maximum results per page (max 1000, default 100). Use with offset for pagination."),
  offset: z.number().optional().describe("Starting position for pagination (1-based). E.g. offset=101 for the second page of 100."),
  asc: z.string().optional().describe("Field to sort ascending"),
  desc: z.string().optional().describe("Field to sort descending"),
  fetchAll: z.boolean().optional().describe("Fetch all results with automatic pagination (use for large datasets)"),
  count: z.boolean().optional().describe("Return count only instead of results"),
}

// -- Line item schemas for transactions --

const salesItemLineSchema = z.object({
  Amount: z.number().describe("Line total amount"),
  DetailType: z.literal("SalesItemLineDetail"),
  Description: z.string().optional().describe("Line description (max 4000 chars)"),
  SalesItemLineDetail: z.object({
    ItemRef: refSchema.describe("Reference to the Item being sold"),
    Qty: z.number().optional().describe("Quantity"),
    UnitPrice: z.number().optional().describe("Price per unit"),
    TaxCodeRef: refSchema.optional().describe("Tax code reference"),
    ServiceDate: z.string().optional().describe("Date service was performed (YYYY-MM-DD)"),
    DiscountRate: z.number().optional().describe("Discount percentage"),
    DiscountAmt: z.number().optional().describe("Discount amount"),
  }),
}).describe("Sales line item (for invoices and estimates)")

const accountExpenseLineSchema = z.object({
  Amount: z.number().describe("Line total amount"),
  DetailType: z.literal("AccountBasedExpenseLineDetail"),
  Description: z.string().optional().describe("Line description"),
  AccountBasedExpenseLineDetail: z.object({
    AccountRef: refSchema.describe("Expense account reference"),
    CustomerRef: refSchema.optional().describe("Customer for billable expenses"),
    ClassRef: refSchema.optional().describe("Class reference"),
    BillableStatus: z.enum(["Billable", "NotBillable", "HasBeenBilled"]).optional(),
    TaxCodeRef: refSchema.optional(),
  }),
}).describe("Account-based expense line (for bills and purchases)")

const itemExpenseLineSchema = z.object({
  Amount: z.number().describe("Line total amount"),
  DetailType: z.literal("ItemBasedExpenseLineDetail"),
  Description: z.string().optional().describe("Line description"),
  ItemBasedExpenseLineDetail: z.object({
    ItemRef: refSchema.describe("Item reference"),
    Qty: z.number().optional().describe("Quantity"),
    UnitPrice: z.number().optional().describe("Unit price"),
    CustomerRef: refSchema.optional().describe("Customer for billable expenses"),
    BillableStatus: z.enum(["Billable", "NotBillable", "HasBeenBilled"]).optional(),
    TaxCodeRef: refSchema.optional(),
  }),
}).describe("Item-based expense line (for bills and purchases)")

const expenseLineSchema = z.union([accountExpenseLineSchema, itemExpenseLineSchema])
  .describe("Expense line item — use AccountBasedExpenseLineDetail for account-based or ItemBasedExpenseLineDetail for item-based")

const journalEntryLineSchema = z.object({
  Amount: z.number().describe("Line amount"),
  DetailType: z.literal("JournalEntryLineDetail"),
  Description: z.string().optional().describe("Line description"),
  JournalEntryLineDetail: z.object({
    PostingType: z.enum(["Debit", "Credit"]).describe("Debit or Credit"),
    AccountRef: refSchema.describe("Account to debit or credit"),
    Entity: z.object({
      Type: z.enum(["Customer", "Vendor", "Employee"]).optional(),
      EntityRef: refSchema.optional(),
    }).optional().describe("Associated entity"),
    ClassRef: refSchema.optional(),
    DepartmentRef: refSchema.optional(),
  }),
}).describe("Journal entry line item (debits must equal credits)")

const billPaymentLineSchema = z.object({
  Amount: z.number().describe("Amount applied to this bill"),
  LinkedTxn: z.array(z.object({
    TxnId: z.string().describe("Bill ID being paid"),
    TxnType: z.literal("Bill"),
  })).describe("Link to the bill being paid"),
}).describe("Bill payment line linking to a specific bill")

// =============================================================================
// McpAgent with all 50 tools
// =============================================================================

export class QuickBooksMCP extends McpAgent<Env, unknown, QBAuthContext> {
  async init() {}

  get qbService() {
    return new QuickBooksService(
      this.env,
      this.props.accessToken,
      this.props.realmId,
      this.props.environment,
      this.props.refreshToken
    )
  }

  formatResponse = (
    data: unknown
  ): { content: Array<{ type: "text"; text: string }> } => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  })

  formatError = (
    error: unknown
  ): { content: Array<{ type: "text"; text: string }>; isError: true } => {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)
    return { content: [{ type: "text", text: message }], isError: true }
  }

  get server() {
    const server = new McpServer({ name: "QuickBooks Online", version: "1.0.0" })

    // =========================================================================
    // CUSTOMERS
    // =========================================================================

    server.registerTool("create_customer", { description: "Create a customer in QuickBooks Online.", inputSchema: {
        DisplayName: z.string().describe("Unique display name for the customer (required)"),
        GivenName: z.string().optional().describe("First name"),
        MiddleName: z.string().optional().describe("Middle name"),
        FamilyName: z.string().optional().describe("Last name"),
        CompanyName: z.string().optional().describe("Company/business name"),
        Title: z.string().optional().describe("Title (Mr., Mrs., etc.)"),
        Suffix: z.string().optional().describe("Suffix (Jr., Sr., etc.)"),
        PrimaryEmailAddr: emailSchema.optional().describe("Primary email"),
        PrimaryPhone: phoneSchema.optional().describe("Primary phone"),
        Mobile: phoneSchema.optional().describe("Mobile phone"),
        BillAddr: addressSchema.optional().describe("Billing address"),
        ShipAddr: addressSchema.optional().describe("Shipping address"),
        Notes: z.string().optional().describe("Free-form notes"),
        Taxable: z.boolean().optional().describe("Is customer taxable"),
        PreferredDeliveryMethod: z.enum(["Print", "Email", "None"]).optional(),
        ParentRef: refSchema.optional().describe("Parent customer (for sub-customers)"),
        Job: z.boolean().optional().describe("Is this a sub-customer/job"),
        CurrencyRef: refSchema.optional().describe("Currency reference (multi-currency)"),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("Customer", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("get_customer", { description: "Get a customer by Id from QuickBooks Online.", inputSchema: { id: z.string().describe("Customer ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("Customer", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_customer", { description: "Update a customer in QuickBooks Online (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Customer ID to update"),
        DisplayName: z.string().optional().describe("Display name"),
        GivenName: z.string().optional().describe("First name"),
        FamilyName: z.string().optional().describe("Last name"),
        CompanyName: z.string().optional().describe("Company name"),
        PrimaryEmailAddr: emailSchema.optional().describe("Email"),
        PrimaryPhone: phoneSchema.optional().describe("Phone"),
        BillAddr: addressSchema.optional().describe("Billing address"),
        ShipAddr: addressSchema.optional().describe("Shipping address"),
        Notes: z.string().optional().describe("Notes"),
        Active: z.boolean().optional().describe("Active status"),
      } }, async (data) => {
        try {
          const result = await this.qbService.sparseUpdate("Customer", data.Id, data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_customer", { description: "Delete (make inactive) a customer in QuickBooks Online.", inputSchema: { id: z.string().describe("Customer ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.sparseUpdate("Customer", id, { Active: false })
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_customers", { description: "Search customers in QuickBooks Online. Filterable fields: Id, DisplayName, GivenName, FamilyName, CompanyName, PrimaryEmailAddr, PrimaryPhone, Balance, Active, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("Customer", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    // =========================================================================
    // INVOICES
    // =========================================================================

    server.registerTool("create_invoice", { description: "Create an invoice in QuickBooks Online.", inputSchema: {
        CustomerRef: refSchema.describe("Customer to invoice (required)"),
        Line: z.array(salesItemLineSchema).min(1).describe("Invoice line items (at least one required)"),
        DocNumber: z.string().optional().describe("Invoice number (max 21 chars)"),
        TxnDate: z.string().optional().describe("Transaction date (YYYY-MM-DD)"),
        DueDate: z.string().optional().describe("Payment due date (YYYY-MM-DD)"),
        PrivateNote: z.string().optional().describe("Internal memo (max 4000 chars)"),
        CustomerMemo: z.object({ value: z.string() }).optional().describe("Message to customer"),
        BillAddr: addressSchema.optional().describe("Billing address"),
        ShipAddr: addressSchema.optional().describe("Shipping address"),
        BillEmail: emailSchema.optional().describe("Email to send invoice to"),
        SalesTermRef: refSchema.optional().describe("Sales terms"),
        DepartmentRef: refSchema.optional().describe("Department/location"),
        Deposit: z.number().optional().describe("Deposit amount"),
        AllowOnlinePayment: z.boolean().optional().describe("Allow online payment"),
        AllowOnlineCreditCardPayment: z.boolean().optional().describe("Allow credit card payment"),
        AllowOnlineACHPayment: z.boolean().optional().describe("Allow ACH payment"),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("Invoice", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("read_invoice", { description: "Read an invoice from QuickBooks Online by its ID.", inputSchema: { id: z.string().describe("Invoice ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("Invoice", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_invoice", { description: "Update an invoice in QuickBooks Online (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Invoice ID to update"),
        patch: z.record(z.any()).describe("Fields to update (e.g. DueDate, PrivateNote, BillEmail, Line, etc.)"),
      } }, async ({ Id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("Invoice", Id, patch)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_invoice", { description: "Void an invoice in QuickBooks Online. Sets the invoice status to voided.", inputSchema: { id: z.string().describe("Invoice ID") } }, async ({ id }) => {
        try {
          const current = await this.qbService.read("Invoice", id)
          const voided = { Id: current.Id, SyncToken: current.SyncToken, sparse: true }
          // QB voids invoices via a POST to the invoice endpoint with ?operation=void (not delete)
          const result = await this.qbService.void("Invoice", voided)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_invoices", { description: "Search invoices in QuickBooks Online. Filterable fields: Id, DocNumber, TxnDate, DueDate, CustomerRef, Balance, TotalAmt, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("Invoice", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    // =========================================================================
    // ACCOUNTS
    // =========================================================================

    server.registerTool("create_account", { description: "Create a chart-of-accounts entry in QuickBooks Online.", inputSchema: {
        Name: z.string().describe("Account name (required, unique, max 100 chars)"),
        AccountType: z.string().describe("Account type (required). Values: Bank, Accounts Receivable, Other Current Asset, Fixed Asset, Other Asset, Accounts Payable, Credit Card, Other Current Liability, Long Term Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense"),
        AccountSubType: z.string().optional().describe("Detailed sub-type (e.g. Checking, Savings, ServiceFeeIncome)"),
        Description: z.string().optional().describe("Account description (max 100 chars)"),
        AcctNum: z.string().optional().describe("User-assigned account number"),
        SubAccount: z.boolean().optional().describe("Is sub-account"),
        ParentRef: refSchema.optional().describe("Parent account for sub-accounts"),
        CurrencyRef: refSchema.optional().describe("Currency (multi-currency)"),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("Account", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("get_account", { description: "Get a chart-of-accounts entry by Id from QuickBooks Online.", inputSchema: { id: z.string().describe("Account ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("Account", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_account", { description: "Update a chart-of-accounts entry in QuickBooks (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Account ID to update"),
        patch: z.record(z.any()).describe("Fields to update (e.g. Name, Description, Active, AcctNum)"),
      } }, async ({ Id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("Account", Id, patch)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_account", { description: "Delete (make inactive) a chart-of-accounts entry in QuickBooks Online.", inputSchema: { id: z.string().describe("Account ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.sparseUpdate("Account", id, { Active: false })
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_accounts", { description: "Search chart-of-accounts entries. Filterable fields: Id, Name, AccountType, Classification, Active, CurrentBalance, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("Account", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    // =========================================================================
    // ITEMS
    // =========================================================================

    server.registerTool("create_item", { description: "Create an item in QuickBooks Online.", inputSchema: {
        Name: z.string().describe("Item name (required, unique, max 100 chars)"),
        Type: z.string().describe("Item type (required): Service, Inventory, NonInventory, Group, FixedAsset, Category"),
        IncomeAccountRef: refSchema.describe("Income account for sales (required for Service/NonInventory)"),
        ExpenseAccountRef: refSchema.optional().describe("Expense/COGS account (required for Inventory)"),
        AssetAccountRef: refSchema.optional().describe("Inventory asset account (required for Inventory)"),
        Description: z.string().optional().describe("Sales description (max 4000 chars)"),
        PurchaseDesc: z.string().optional().describe("Purchase description"),
        UnitPrice: z.number().optional().describe("Sales price per unit"),
        PurchaseCost: z.number().optional().describe("Purchase cost per unit"),
        Taxable: z.boolean().optional().describe("Is item taxable"),
        Sku: z.string().optional().describe("Stock keeping unit (max 100 chars)"),
        TrackQtyOnHand: z.boolean().optional().describe("Track quantity (required true for Inventory)"),
        QtyOnHand: z.number().optional().describe("Starting quantity (required for Inventory)"),
        InvStartDate: z.string().optional().describe("Inventory start date (required for Inventory, YYYY-MM-DD)"),
        ReorderPoint: z.number().optional().describe("Reorder point for inventory"),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("Item", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("read_item", { description: "Read an item from QuickBooks Online by its ID.", inputSchema: { id: z.string().describe("Item ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("Item", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_item", { description: "Update an item in QuickBooks (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Item ID to update"),
        patch: z.record(z.any()).describe("Fields to update (e.g. Name, UnitPrice, Description, Active, Sku)"),
      } }, async ({ Id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("Item", Id, patch)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_item", { description: "Delete (make inactive) an item in QuickBooks Online.", inputSchema: { id: z.string().describe("Item ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.sparseUpdate("Item", id, { Active: false })
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_items", { description: "Search items in QuickBooks Online. Filterable fields: Id, Name, Active, Type, Sku, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("Item", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    // =========================================================================
    // ESTIMATES
    // =========================================================================

    server.registerTool("create_estimate", { description: "Create an estimate in QuickBooks Online.", inputSchema: {
        CustomerRef: refSchema.describe("Customer for this estimate (required)"),
        Line: z.array(salesItemLineSchema).min(1).describe("Estimate line items (at least one required)"),
        DocNumber: z.string().optional().describe("Estimate number"),
        TxnDate: z.string().optional().describe("Transaction date (YYYY-MM-DD)"),
        DueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
        ExpirationDate: z.string().optional().describe("Expiration date (YYYY-MM-DD)"),
        PrivateNote: z.string().optional().describe("Internal memo"),
        CustomerMemo: z.object({ value: z.string() }).optional().describe("Message to customer"),
        BillAddr: addressSchema.optional(),
        ShipAddr: addressSchema.optional(),
        BillEmail: emailSchema.optional(),
        DepartmentRef: refSchema.optional(),
        TxnStatus: z.enum(["Pending", "Accepted", "Closed", "Rejected"]).optional(),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("Estimate", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("get_estimate", { description: "Get an estimate by Id from QuickBooks Online.", inputSchema: { id: z.string().describe("Estimate ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("Estimate", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_estimate", { description: "Update an estimate in QuickBooks Online (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Estimate ID to update"),
        patch: z.record(z.any()).describe("Fields to update"),
      } }, async ({ Id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("Estimate", Id, patch)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_estimate", { description: "Delete an estimate in QuickBooks Online.", inputSchema: { id: z.string().describe("Estimate ID") } }, async ({ id }) => {
        try {
          const current = await this.qbService.read("Estimate", id)
          const result = await this.qbService.delete("Estimate", { Id: current.Id, SyncToken: current.SyncToken })
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_estimates", { description: "Search estimates in QuickBooks Online. Filterable fields: Id, DocNumber, TxnDate, TxnStatus, CustomerRef, TotalAmt, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("Estimate", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    // =========================================================================
    // BILLS
    // =========================================================================

    server.registerTool("create_bill", { description: "Create a bill (accounts payable) in QuickBooks Online. Line items must use AccountBasedExpenseLineDetail or ItemBasedExpenseLineDetail.", inputSchema: {
        VendorRef: refSchema.describe("Vendor this bill is from (required)"),
        Line: z.array(expenseLineSchema).min(1).describe("Bill line items (at least one required)"),
        DocNumber: z.string().optional().describe("Bill/reference number"),
        TxnDate: z.string().optional().describe("Bill date (YYYY-MM-DD)"),
        DueDate: z.string().optional().describe("Payment due date (YYYY-MM-DD)"),
        PrivateNote: z.string().optional().describe("Internal memo"),
        APAccountRef: refSchema.optional().describe("Accounts payable account"),
        SalesTermRef: refSchema.optional().describe("Payment terms"),
        DepartmentRef: refSchema.optional().describe("Department/location"),
        CurrencyRef: refSchema.optional().describe("Currency (multi-currency)"),
        ExchangeRate: z.number().optional().describe("Exchange rate"),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("Bill", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("get_bill", { description: "Get a bill by ID from QuickBooks Online.", inputSchema: { id: z.string().describe("Bill ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("Bill", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_bill", { description: "Update a bill in QuickBooks Online (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Bill ID to update"),
        patch: z.record(z.any()).describe("Fields to update (e.g. DueDate, PrivateNote, Line, VendorRef)"),
      } }, async ({ Id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("Bill", Id, patch)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_bill", { description: "Delete a bill in QuickBooks Online.", inputSchema: { id: z.string().describe("Bill ID") } }, async ({ id }) => {
        try {
          const current = await this.qbService.read("Bill", id)
          const result = await this.qbService.delete("Bill", { Id: current.Id, SyncToken: current.SyncToken })
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_bills", { description: "Search bills in QuickBooks Online. Filterable fields: Id, DocNumber, TxnDate, DueDate, VendorRef, Balance, TotalAmt, APAccountRef, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("Bill", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    // =========================================================================
    // VENDORS
    // =========================================================================

    server.registerTool("create_vendor", { description: "Create a vendor in QuickBooks Online.", inputSchema: {
        DisplayName: z.string().describe("Unique vendor display name (required)"),
        GivenName: z.string().optional().describe("First name"),
        MiddleName: z.string().optional().describe("Middle name"),
        FamilyName: z.string().optional().describe("Last name"),
        CompanyName: z.string().optional().describe("Company name"),
        Title: z.string().optional().describe("Title (Mr., Mrs.)"),
        Suffix: z.string().optional().describe("Suffix (Jr., Sr.)"),
        PrimaryEmailAddr: emailSchema.optional().describe("Email"),
        PrimaryPhone: phoneSchema.optional().describe("Phone"),
        Mobile: phoneSchema.optional().describe("Mobile phone"),
        Fax: phoneSchema.optional().describe("Fax number"),
        BillAddr: addressSchema.optional().describe("Billing/mailing address"),
        AcctNum: z.string().optional().describe("Account number with this vendor"),
        TaxIdentifier: z.string().optional().describe("Tax ID / EIN"),
        Vendor1099: z.boolean().optional().describe("Is 1099 vendor"),
        TermRef: refSchema.optional().describe("Payment terms"),
        CurrencyRef: refSchema.optional().describe("Currency (multi-currency)"),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("Vendor", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("get_vendor", { description: "Get a vendor by ID from QuickBooks Online.", inputSchema: { id: z.string().describe("Vendor ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("Vendor", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_vendor", { description: "Update a vendor in QuickBooks Online (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Vendor ID to update"),
        DisplayName: z.string().optional().describe("Display name"),
        GivenName: z.string().optional().describe("First name"),
        FamilyName: z.string().optional().describe("Last name"),
        CompanyName: z.string().optional().describe("Company name"),
        PrimaryEmailAddr: emailSchema.optional().describe("Email"),
        PrimaryPhone: phoneSchema.optional().describe("Phone"),
        BillAddr: addressSchema.optional().describe("Address"),
        Active: z.boolean().optional().describe("Active status"),
        AcctNum: z.string().optional().describe("Account number"),
        Vendor1099: z.boolean().optional().describe("1099 vendor"),
      } }, async (data) => {
        try {
          const result = await this.qbService.sparseUpdate("Vendor", data.Id, data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_vendor", { description: "Delete (make inactive) a vendor in QuickBooks Online.", inputSchema: { id: z.string().describe("Vendor ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.sparseUpdate("Vendor", id, { Active: false })
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_vendors", { description: "Search vendors in QuickBooks Online. Filterable fields: Id, DisplayName, GivenName, FamilyName, CompanyName, Active, Balance, Vendor1099, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("Vendor", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    // =========================================================================
    // EMPLOYEES
    // =========================================================================

    server.registerTool("create_employee", { description: "Create an employee in QuickBooks Online. At least GivenName or FamilyName is required.", inputSchema: {
        GivenName: z.string().optional().describe("First name (required if FamilyName not provided)"),
        FamilyName: z.string().optional().describe("Last name (required if GivenName not provided)"),
        DisplayName: z.string().optional().describe("Display name (auto-generated from names if omitted)"),
        MiddleName: z.string().optional().describe("Middle name"),
        Title: z.string().optional().describe("Title"),
        Suffix: z.string().optional().describe("Suffix"),
        PrimaryEmailAddr: emailSchema.optional().describe("Email"),
        PrimaryPhone: phoneSchema.optional().describe("Phone"),
        Mobile: phoneSchema.optional().describe("Mobile phone"),
        PrimaryAddr: addressSchema.optional().describe("Primary address"),
        SSN: z.string().optional().describe("Social security number"),
        EmployeeNumber: z.string().optional().describe("Employee number/ID"),
        BillableTime: z.boolean().optional().describe("Has billable time"),
        BillRate: z.number().optional().describe("Billing rate"),
        HiredDate: z.string().optional().describe("Hire date (YYYY-MM-DD)"),
        BirthDate: z.string().optional().describe("Birth date (YYYY-MM-DD)"),
        Gender: z.enum(["Male", "Female"]).optional().describe("Gender"),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("Employee", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("get_employee", { description: "Get an employee by Id from QuickBooks Online.", inputSchema: { id: z.string().describe("Employee ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("Employee", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_employee", { description: "Update an employee in QuickBooks Online (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Employee ID to update"),
        GivenName: z.string().optional().describe("First name"),
        FamilyName: z.string().optional().describe("Last name"),
        DisplayName: z.string().optional().describe("Display name"),
        PrimaryEmailAddr: emailSchema.optional().describe("Email"),
        PrimaryPhone: phoneSchema.optional().describe("Phone"),
        PrimaryAddr: addressSchema.optional().describe("Address"),
        Active: z.boolean().optional().describe("Active status"),
        BillRate: z.number().optional().describe("Billing rate"),
        HiredDate: z.string().optional().describe("Hire date"),
        ReleasedDate: z.string().optional().describe("Termination date"),
      } }, async (data) => {
        try {
          const result = await this.qbService.sparseUpdate("Employee", data.Id, data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_employee", { description: "Delete (make inactive) an employee in QuickBooks Online.", inputSchema: { id: z.string().describe("Employee ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.sparseUpdate("Employee", id, { Active: false })
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_employees", { description: "Search employees in QuickBooks Online. Filterable fields: Id, DisplayName, GivenName, FamilyName, Active, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("Employee", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    // =========================================================================
    // JOURNAL ENTRIES
    // =========================================================================

    server.registerTool("create_journal_entry", { description: "Create a journal entry in QuickBooks Online. Debits must equal credits.", inputSchema: {
        Line: z.array(journalEntryLineSchema).min(2).describe("Journal entry lines (at least 2 required; debits must equal credits)"),
        DocNumber: z.string().optional().describe("Journal entry number"),
        TxnDate: z.string().optional().describe("Transaction date (YYYY-MM-DD)"),
        PrivateNote: z.string().optional().describe("Internal memo"),
        DepartmentRef: refSchema.optional().describe("Department/location"),
        CurrencyRef: refSchema.optional().describe("Currency (multi-currency)"),
        ExchangeRate: z.number().optional().describe("Exchange rate"),
        Adjustment: z.boolean().optional().describe("Is this an adjustment entry"),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("JournalEntry", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("get_journal_entry", { description: "Get a journal entry by Id from QuickBooks Online.", inputSchema: { id: z.string().describe("Journal entry ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("JournalEntry", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_journal_entry", { description: "Update a journal entry in QuickBooks Online (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Journal entry ID to update"),
        patch: z.record(z.any()).describe("Fields to update (e.g. Line, TxnDate, PrivateNote)"),
      } }, async ({ Id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("JournalEntry", Id, patch)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_journal_entry", { description: "Delete a journal entry in QuickBooks Online.", inputSchema: { id: z.string().describe("Journal entry ID") } }, async ({ id }) => {
        try {
          const current = await this.qbService.read("JournalEntry", id)
          const result = await this.qbService.delete("JournalEntry", { Id: current.Id, SyncToken: current.SyncToken })
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_journal_entries", { description: "Search journal entries in QuickBooks Online. Filterable fields: Id, DocNumber, TxnDate, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("JournalEntry", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    // =========================================================================
    // BILL PAYMENTS
    // =========================================================================

    server.registerTool("create_bill_payment", { description: "Create a bill payment in QuickBooks Online. Links a payment to one or more bills.", inputSchema: {
        VendorRef: refSchema.describe("Vendor being paid (required)"),
        PayType: z.enum(["Check", "CreditCard"]).describe("Payment type (required)"),
        TotalAmt: z.number().describe("Total payment amount (required)"),
        Line: z.array(billPaymentLineSchema).min(1).describe("Lines linking to bills being paid (required)"),
        CheckPayment: z.object({
          BankAccountRef: refSchema.describe("Bank account for check payment"),
          PrintStatus: z.enum(["NotSet", "NeedToPrint", "PrintComplete"]).optional(),
        }).optional().describe("Required when PayType is 'Check'"),
        CreditCardPayment: z.object({
          CCAccountRef: refSchema.describe("Credit card account"),
        }).optional().describe("Required when PayType is 'CreditCard'"),
        DocNumber: z.string().optional().describe("Payment reference number"),
        TxnDate: z.string().optional().describe("Payment date (YYYY-MM-DD)"),
        PrivateNote: z.string().optional().describe("Internal memo"),
        APAccountRef: refSchema.optional().describe("Accounts payable account"),
        DepartmentRef: refSchema.optional().describe("Department/location"),
        CurrencyRef: refSchema.optional(),
        ExchangeRate: z.number().optional(),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("BillPayment", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("get_bill_payment", { description: "Get a bill payment by Id from QuickBooks Online.", inputSchema: { id: z.string().describe("Bill payment ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("BillPayment", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_bill_payment", { description: "Update a bill payment in QuickBooks Online (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Bill payment ID to update"),
        patch: z.record(z.any()).describe("Fields to update"),
      } }, async ({ Id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("BillPayment", Id, patch)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_bill_payment", { description: "Delete a bill payment in QuickBooks Online.", inputSchema: { id: z.string().describe("Bill payment ID") } }, async ({ id }) => {
        try {
          const current = await this.qbService.read("BillPayment", id)
          const result = await this.qbService.delete("BillPayment", { Id: current.Id, SyncToken: current.SyncToken })
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_bill_payments", { description: "Search bill payments in QuickBooks Online. Filterable fields: Id, VendorRef, TxnDate, PayType, TotalAmt, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("BillPayment", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    // =========================================================================
    // PURCHASES
    // =========================================================================

    server.registerTool("create_purchase", { description: "Create a purchase (expense/check/credit card charge) in QuickBooks Online.", inputSchema: {
        PaymentType: z.enum(["Cash", "Check", "CreditCard"]).describe("Payment type (required)"),
        AccountRef: refSchema.describe("Bank or credit card account (required)"),
        Line: z.array(expenseLineSchema).min(1).describe("Purchase line items (at least one required)"),
        EntityRef: refSchema.optional().describe("Associated vendor, customer, or employee"),
        DocNumber: z.string().optional().describe("Reference/check number"),
        TxnDate: z.string().optional().describe("Transaction date (YYYY-MM-DD)"),
        PrivateNote: z.string().optional().describe("Internal memo"),
        DepartmentRef: refSchema.optional().describe("Department/location"),
        CurrencyRef: refSchema.optional().describe("Currency (multi-currency)"),
        ExchangeRate: z.number().optional().describe("Exchange rate"),
        Credit: z.boolean().optional().describe("True for credit card refund"),
        PaymentMethodRef: refSchema.optional().describe("Payment method"),
      } }, async (data) => {
        try {
          const result = await this.qbService.create("Purchase", data)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("get_purchase", { description: "Get a purchase by Id from QuickBooks Online.", inputSchema: { id: z.string().describe("Purchase ID") } }, async ({ id }) => {
        try {
          const result = await this.qbService.read("Purchase", id)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("update_purchase", { description: "Update a purchase in QuickBooks Online (sparse update). SyncToken is fetched automatically.", inputSchema: {
        Id: z.string().describe("Purchase ID to update"),
        patch: z.record(z.any()).describe("Fields to update (e.g. TxnDate, PrivateNote, Line)"),
      } }, async ({ Id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("Purchase", Id, patch)
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("delete_purchase", { description: "Delete a purchase in QuickBooks Online.", inputSchema: { id: z.string().describe("Purchase ID") } }, async ({ id }) => {
        try {
          const current = await this.qbService.read("Purchase", id)
          const result = await this.qbService.delete("Purchase", { Id: current.Id, SyncToken: current.SyncToken })
          return this.formatResponse(result)
        } catch (e) { return this.formatError(e) }
      }
    )

    server.registerTool("search_purchases", { description: "Search purchases in QuickBooks Online. Filterable fields: Id, TxnDate, PaymentType, AccountRef, EntityRef, TotalAmt, MetaData.CreateTime, MetaData.LastUpdatedTime.", inputSchema: searchOptionsSchema }, async (opts) => {
      try {
        const result = await this.qbService.search("Purchase", opts)
        return this.formatResponse(result)
      } catch (e) { return this.formatError(e) }
    })

    return server
  }
}
