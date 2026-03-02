/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpAgent } from "agents/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { QuickBooksService } from "./QuickBooksService.ts"
// QBAuthContext is declared globally in types.d.ts

// Shared schemas used across multiple tools
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
  limit: z.number().optional().describe("Maximum number of results to return"),
  offset: z.number().optional().describe("Starting position for pagination"),
  asc: z.string().optional().describe("Field to sort ascending"),
  desc: z.string().optional().describe("Field to sort descending"),
  fetchAll: z.boolean().optional().describe("Fetch all results ignoring limit"),
  count: z.boolean().optional().describe("Return count instead of results"),
}

export class QuickBooksMCP extends McpAgent<Env, unknown, QBAuthContext> {
  async init() {
    // Initialize any necessary state
  }

  get qbService() {
    return new QuickBooksService(
      this.env,
      this.props.accessToken,
      this.props.refreshToken,
      this.props.realmId
    )
  }

  formatResponse = (
    description: string,
    data: unknown
  ): { content: Array<{ type: "text"; text: string }> } => {
    return {
      content: [
        {
          type: "text",
          text: `${description}\n\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    }
  }

  formatError = (
    error: unknown
  ): { content: Array<{ type: "text"; text: string }>; isError: true } => {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    }
  }

  get server() {
    const server = new McpServer({
      name: "QuickBooks Online",
      version: "1.0.0",
    })

    // =========================================================================
    // CUSTOMERS
    // =========================================================================

    server.tool(
      "create_customer",
      "Create a customer in QuickBooks Online.",
      { customer: z.any().describe("Customer object to create") },
      async ({ customer }) => {
        try {
          const result = await this.qbService.create("Customer", customer)
          return this.formatResponse("Customer created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "get_customer",
      "Get a customer by Id from QuickBooks Online.",
      { id: z.string().describe("Customer ID") },
      async ({ id }) => {
        try {
          const result = await this.qbService.read("Customer", id)
          return this.formatResponse(`Customer ${id} retrieved.`, result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_customer",
      "Update an existing customer in QuickBooks Online.",
      { customer: z.any().describe("Customer object with Id and SyncToken") },
      async ({ customer }) => {
        try {
          const result = await this.qbService.update("Customer", customer)
          return this.formatResponse("Customer updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "delete_customer",
      "Delete (make inactive) a customer in QuickBooks Online.",
      { idOrEntity: z.any().describe("Customer ID or entity object with Id and SyncToken") },
      async ({ idOrEntity }) => {
        try {
          // Customers cannot be truly deleted in QB — they are made inactive
          let entity: any
          if (typeof idOrEntity === "string" || typeof idOrEntity === "number") {
            entity = await this.qbService.read("Customer", String(idOrEntity))
          } else {
            entity = idOrEntity
          }
          entity.Active = false
          const result = await this.qbService.update("Customer", entity)
          return this.formatResponse("Customer deactivated.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_customers", "Search customers in QuickBooks Online that match given criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("Customer", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} customers.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    // =========================================================================
    // INVOICES
    // =========================================================================

    server.tool(
      "create_invoice",
      "Create an invoice in QuickBooks Online.",
      {
        customer_ref: z.string().min(1).describe("Customer ID"),
        line_items: z
          .array(
            z.object({
              item_ref: z.string().min(1).describe("Item ID"),
              qty: z.number().positive().describe("Quantity"),
              unit_price: z.number().nonnegative().describe("Unit price"),
              description: z.string().optional().describe("Line description"),
            })
          )
          .min(1)
          .describe("Invoice line items"),
        doc_number: z.string().optional().describe("Document number"),
        txn_date: z.string().optional().describe("Transaction date (YYYY-MM-DD)"),
      },
      async ({ customer_ref, line_items, doc_number, txn_date }) => {
        try {
          const payload: any = {
            CustomerRef: { value: customer_ref },
            Line: line_items.map((l, idx) => ({
              Id: `${idx + 1}`,
              LineNum: idx + 1,
              Description: l.description || undefined,
              Amount: l.qty * l.unit_price,
              DetailType: "SalesItemLineDetail",
              SalesItemLineDetail: {
                ItemRef: { value: l.item_ref },
                Qty: l.qty,
                UnitPrice: l.unit_price,
              },
            })),
            DocNumber: doc_number,
            TxnDate: txn_date,
          }
          const result = await this.qbService.create("Invoice", payload)
          return this.formatResponse("Invoice created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "read_invoice",
      "Read a single invoice from QuickBooks Online by its ID.",
      { invoice_id: z.string().min(1).describe("Invoice ID") },
      async ({ invoice_id }) => {
        try {
          const result = await this.qbService.read("Invoice", invoice_id)
          return this.formatResponse(`Invoice ${invoice_id} retrieved.`, result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_invoice",
      "Update an existing invoice in Quickbooks by ID (sparse update).",
      {
        invoice_id: z.string().min(1).describe("Invoice ID"),
        patch: z.record(z.any()).describe("Fields to update"),
      },
      async ({ invoice_id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("Invoice", invoice_id, patch)
          return this.formatResponse("Invoice updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_invoices", "Search invoices in QuickBooks Online using criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("Invoice", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} invoices.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    // =========================================================================
    // ACCOUNTS
    // =========================================================================

    server.tool(
      "create_account",
      "Create a chart-of-accounts entry in QuickBooks Online.",
      {
        name: z.string().min(1).describe("Account name"),
        type: z.string().min(1).describe("Account type (e.g. Expense, Income, Bank)"),
        sub_type: z.string().optional().describe("Account sub-type"),
        description: z.string().optional().describe("Account description"),
      },
      async ({ name, type, sub_type, description }) => {
        try {
          const payload: any = {
            Name: name,
            AccountType: type,
            AccountSubType: sub_type,
            Description: description,
          }
          const result = await this.qbService.create("Account", payload)
          return this.formatResponse("Account created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_account",
      "Update an existing chart-of-accounts entry in QuickBooks.",
      {
        account_id: z.string().min(1).describe("Account ID"),
        patch: z.record(z.any()).describe("Fields to update"),
      },
      async ({ account_id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("Account", account_id, patch)
          return this.formatResponse("Account updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_accounts", "Search chart-of-accounts entries using criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("Account", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} accounts.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    // =========================================================================
    // ITEMS
    // =========================================================================

    server.tool(
      "create_item",
      "Create an item in QuickBooks Online.",
      {
        name: z.string().min(1).describe("Item name"),
        type: z.string().min(1).describe("Item type (e.g. Service, Inventory, NonInventory)"),
        income_account_ref: z.string().min(1).describe("Income account ID"),
        expense_account_ref: z.string().optional().describe("Expense account ID"),
        unit_price: z.number().optional().describe("Unit price"),
        description: z.string().optional().describe("Item description"),
      },
      async ({ name, type, income_account_ref, expense_account_ref, unit_price, description }) => {
        try {
          const payload: any = {
            Name: name,
            Type: type,
            IncomeAccountRef: { value: income_account_ref },
            Description: description,
            UnitPrice: unit_price,
          }
          if (expense_account_ref) {
            payload.ExpenseAccountRef = { value: expense_account_ref }
          }
          const result = await this.qbService.create("Item", payload)
          return this.formatResponse("Item created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "read_item",
      "Read a single item in QuickBooks Online by its ID.",
      { item_id: z.string().min(1).describe("Item ID") },
      async ({ item_id }) => {
        try {
          const result = await this.qbService.read("Item", item_id)
          return this.formatResponse(`Item ${item_id} retrieved.`, result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_item",
      "Update an existing item in QuickBooks by ID (sparse update).",
      {
        item_id: z.string().min(1).describe("Item ID"),
        patch: z.record(z.any()).describe("Fields to update"),
      },
      async ({ item_id, patch }) => {
        try {
          const result = await this.qbService.sparseUpdate("Item", item_id, patch)
          return this.formatResponse("Item updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_items", "Search items in QuickBooks Online using criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("Item", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} items.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    // =========================================================================
    // ESTIMATES
    // =========================================================================

    server.tool(
      "create_estimate",
      "Create an estimate in QuickBooks Online.",
      { estimate: z.any().describe("Estimate object to create") },
      async ({ estimate }) => {
        try {
          const result = await this.qbService.create("Estimate", estimate)
          return this.formatResponse("Estimate created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "get_estimate",
      "Get an estimate by Id from QuickBooks Online.",
      { id: z.string().describe("Estimate ID") },
      async ({ id }) => {
        try {
          const result = await this.qbService.read("Estimate", id)
          return this.formatResponse(`Estimate ${id} retrieved.`, result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_estimate",
      "Update an estimate in QuickBooks Online.",
      { estimate: z.any().describe("Estimate object with Id and SyncToken") },
      async ({ estimate }) => {
        try {
          const result = await this.qbService.update("Estimate", estimate)
          return this.formatResponse("Estimate updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "delete_estimate",
      "Delete (void) an estimate in QuickBooks Online.",
      { idOrEntity: z.any().describe("Estimate ID or entity object with Id and SyncToken") },
      async ({ idOrEntity }) => {
        try {
          let entity: any
          if (typeof idOrEntity === "string" || typeof idOrEntity === "number") {
            entity = await this.qbService.read("Estimate", String(idOrEntity))
          } else {
            entity = idOrEntity
          }
          const result = await this.qbService.delete("Estimate", entity)
          return this.formatResponse("Estimate deleted.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_estimates", "Search estimates in QuickBooks Online that match given criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("Estimate", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} estimates.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    // =========================================================================
    // BILLS
    // =========================================================================

    server.tool(
      "create_bill",
      "Create a bill in QuickBooks Online.",
      {
        bill: z.object({
          Line: z.array(
            z.object({
              Amount: z.number(),
              DetailType: z.string(),
              Description: z.string(),
              AccountRef: z.object({
                value: z.string(),
                name: z.string().optional(),
              }),
            })
          ),
          VendorRef: z.object({
            value: z.string(),
            name: z.string().optional(),
          }),
          DueDate: z.string(),
          Balance: z.number(),
          TotalAmt: z.number(),
        }),
      },
      async ({ bill }) => {
        try {
          const result = await this.qbService.create("Bill", bill)
          return this.formatResponse("Bill created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "get_bill",
      "Get a bill by ID from QuickBooks Online.",
      { id: z.string().describe("Bill ID") },
      async ({ id }) => {
        try {
          const result = await this.qbService.read("Bill", id)
          return this.formatResponse(`Bill ${id} retrieved.`, result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_bill",
      "Update a bill in QuickBooks Online.",
      {
        bill: z.object({
          Id: z.string(),
          Line: z.array(
            z.object({
              Amount: z.number(),
              DetailType: z.string(),
              Description: z.string(),
              AccountRef: z.object({
                value: z.string(),
                name: z.string().optional(),
              }),
            })
          ),
          VendorRef: z.object({
            value: z.string(),
            name: z.string().optional(),
          }),
          DueDate: z.string(),
          Balance: z.number(),
          TotalAmt: z.number(),
        }),
      },
      async ({ bill }) => {
        try {
          // Fetch current to get SyncToken
          const current = await this.qbService.read("Bill", bill.Id)
          const merged = { ...bill, SyncToken: current.SyncToken }
          const result = await this.qbService.update("Bill", merged)
          return this.formatResponse("Bill updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "delete_bill",
      "Delete a bill in QuickBooks Online.",
      {
        bill: z.object({
          Id: z.string(),
          SyncToken: z.string(),
        }),
      },
      async ({ bill }) => {
        try {
          const result = await this.qbService.delete("Bill", bill)
          return this.formatResponse("Bill deleted.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_bills", "Search bills in QuickBooks Online that match given criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("Bill", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} bills.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    // =========================================================================
    // VENDORS
    // =========================================================================

    server.tool(
      "create_vendor",
      "Create a vendor in QuickBooks Online.",
      {
        vendor: z.object({
          DisplayName: z.string(),
          GivenName: z.string().optional(),
          FamilyName: z.string().optional(),
          CompanyName: z.string().optional(),
          PrimaryEmailAddr: z.object({ Address: z.string().optional() }).optional(),
          PrimaryPhone: z.object({ FreeFormNumber: z.string().optional() }).optional(),
          BillAddr: z
            .object({
              Line1: z.string().optional(),
              City: z.string().optional(),
              Country: z.string().optional(),
              CountrySubDivisionCode: z.string().optional(),
              PostalCode: z.string().optional(),
            })
            .optional(),
        }),
      },
      async ({ vendor }) => {
        try {
          const result = await this.qbService.create("Vendor", vendor)
          return this.formatResponse("Vendor created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "get_vendor",
      "Get a vendor by ID from QuickBooks Online.",
      { id: z.string().describe("Vendor ID") },
      async ({ id }) => {
        try {
          const result = await this.qbService.read("Vendor", id)
          return this.formatResponse(`Vendor ${id} retrieved.`, result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_vendor",
      "Update a vendor in QuickBooks Online.",
      {
        vendor: z.object({
          Id: z.string(),
          SyncToken: z.string(),
          DisplayName: z.string(),
          GivenName: z.string().optional(),
          FamilyName: z.string().optional(),
          CompanyName: z.string().optional(),
          PrimaryEmailAddr: z.object({ Address: z.string().optional() }).optional(),
          PrimaryPhone: z.object({ FreeFormNumber: z.string().optional() }).optional(),
          BillAddr: z
            .object({
              Line1: z.string().optional(),
              City: z.string().optional(),
              Country: z.string().optional(),
              CountrySubDivisionCode: z.string().optional(),
              PostalCode: z.string().optional(),
            })
            .optional(),
        }),
      },
      async ({ vendor }) => {
        try {
          const result = await this.qbService.update("Vendor", vendor)
          return this.formatResponse("Vendor updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "delete_vendor",
      "Delete a vendor in QuickBooks Online.",
      {
        vendor: z.object({
          Id: z.string(),
          SyncToken: z.string(),
        }),
      },
      async ({ vendor }) => {
        try {
          // Vendors are made inactive (Active: false) rather than hard-deleted
          const entity = { ...vendor, Active: false }
          const result = await this.qbService.update("Vendor", entity)
          return this.formatResponse("Vendor deleted.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_vendors", "Search vendors in QuickBooks Online that match given criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("Vendor", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} vendors.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    // =========================================================================
    // EMPLOYEES
    // =========================================================================

    server.tool(
      "create_employee",
      "Create an employee in QuickBooks Online.",
      { employee: z.any().describe("Employee object to create") },
      async ({ employee }) => {
        try {
          const result = await this.qbService.create("Employee", employee)
          return this.formatResponse("Employee created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "get_employee",
      "Get an employee by Id from QuickBooks Online.",
      { id: z.string().describe("Employee ID") },
      async ({ id }) => {
        try {
          const result = await this.qbService.read("Employee", id)
          return this.formatResponse(`Employee ${id} retrieved.`, result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_employee",
      "Update an employee in QuickBooks Online.",
      { employee: z.any().describe("Employee object with Id and SyncToken") },
      async ({ employee }) => {
        try {
          const result = await this.qbService.update("Employee", employee)
          return this.formatResponse("Employee updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_employees", "Search employees in QuickBooks Online that match given criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("Employee", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} employees.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    // =========================================================================
    // JOURNAL ENTRIES
    // =========================================================================

    server.tool(
      "create_journal_entry",
      "Create a journal entry in QuickBooks Online.",
      { journalEntry: z.any().describe("Journal entry object to create") },
      async ({ journalEntry }) => {
        try {
          const result = await this.qbService.create("JournalEntry", journalEntry)
          return this.formatResponse("Journal entry created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "get_journal_entry",
      "Get a journal entry by Id from QuickBooks Online.",
      { id: z.string().describe("Journal entry ID") },
      async ({ id }) => {
        try {
          const result = await this.qbService.read("JournalEntry", id)
          return this.formatResponse(`Journal entry ${id} retrieved.`, result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_journal_entry",
      "Update a journal entry in QuickBooks Online.",
      { journalEntry: z.any().describe("Journal entry object with Id and SyncToken") },
      async ({ journalEntry }) => {
        try {
          const result = await this.qbService.update("JournalEntry", journalEntry)
          return this.formatResponse("Journal entry updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "delete_journal_entry",
      "Delete (make inactive) a journal entry in QuickBooks Online.",
      { idOrEntity: z.any().describe("Journal entry ID or entity object with Id and SyncToken") },
      async ({ idOrEntity }) => {
        try {
          let entity: any
          if (typeof idOrEntity === "string" || typeof idOrEntity === "number") {
            entity = await this.qbService.read("JournalEntry", String(idOrEntity))
          } else {
            entity = idOrEntity
          }
          const result = await this.qbService.delete("JournalEntry", entity)
          return this.formatResponse("Journal entry deleted.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_journal_entries", "Search journal entries in QuickBooks Online that match given criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("JournalEntry", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} journal entries.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    // =========================================================================
    // BILL PAYMENTS
    // =========================================================================

    server.tool(
      "create_bill_payment",
      "Create a bill payment in QuickBooks Online.",
      { billPayment: z.any().describe("Bill payment object to create") },
      async ({ billPayment }) => {
        try {
          const result = await this.qbService.create("BillPayment", billPayment)
          return this.formatResponse("Bill payment created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "get_bill_payment",
      "Get a bill payment by Id from QuickBooks Online.",
      { id: z.string().describe("Bill payment ID") },
      async ({ id }) => {
        try {
          const result = await this.qbService.read("BillPayment", id)
          return this.formatResponse(`Bill payment ${id} retrieved.`, result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_bill_payment",
      "Update a bill payment in QuickBooks Online.",
      { billPayment: z.any().describe("Bill payment object with Id and SyncToken") },
      async ({ billPayment }) => {
        try {
          const result = await this.qbService.update("BillPayment", billPayment)
          return this.formatResponse("Bill payment updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "delete_bill_payment",
      "Delete (make inactive) a bill payment in QuickBooks Online.",
      { idOrEntity: z.any().describe("Bill payment ID or entity object with Id and SyncToken") },
      async ({ idOrEntity }) => {
        try {
          let entity: any
          if (typeof idOrEntity === "string" || typeof idOrEntity === "number") {
            entity = await this.qbService.read("BillPayment", String(idOrEntity))
          } else {
            entity = idOrEntity
          }
          const result = await this.qbService.delete("BillPayment", entity)
          return this.formatResponse("Bill payment deleted.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_bill_payments", "Search bill payments in QuickBooks Online that match given criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("BillPayment", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} bill payments.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    // =========================================================================
    // PURCHASES
    // =========================================================================

    server.tool(
      "create_purchase",
      "Create a purchase in QuickBooks Online.",
      { purchase: z.any().describe("Purchase object to create") },
      async ({ purchase }) => {
        try {
          const result = await this.qbService.create("Purchase", purchase)
          return this.formatResponse("Purchase created successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "get_purchase",
      "Get a purchase by Id from QuickBooks Online.",
      { id: z.string().describe("Purchase ID") },
      async ({ id }) => {
        try {
          const result = await this.qbService.read("Purchase", id)
          return this.formatResponse(`Purchase ${id} retrieved.`, result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "update_purchase",
      "Update a purchase in QuickBooks Online.",
      { purchase: z.any().describe("Purchase object with Id and SyncToken") },
      async ({ purchase }) => {
        try {
          const result = await this.qbService.update("Purchase", purchase)
          return this.formatResponse("Purchase updated successfully.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool(
      "delete_purchase",
      "Delete (make inactive) a purchase in QuickBooks Online.",
      { idOrEntity: z.any().describe("Purchase ID or entity object with Id and SyncToken") },
      async ({ idOrEntity }) => {
        try {
          let entity: any
          if (typeof idOrEntity === "string" || typeof idOrEntity === "number") {
            entity = await this.qbService.read("Purchase", String(idOrEntity))
          } else {
            entity = idOrEntity
          }
          const result = await this.qbService.delete("Purchase", entity)
          return this.formatResponse("Purchase deleted.", result)
        } catch (e) {
          return this.formatError(e)
        }
      }
    )

    server.tool("search_purchases", "Search purchases in QuickBooks Online that match given criteria.", searchOptionsSchema, async (opts) => {
      try {
        const result = await this.qbService.search("Purchase", opts)
        return this.formatResponse(
          typeof result === "number" ? `Count: ${result}` : `Found ${result.length} purchases.`,
          result
        )
      } catch (e) {
        return this.formatError(e)
      }
    })

    return server
  }
}
