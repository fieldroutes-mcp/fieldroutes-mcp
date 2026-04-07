import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ── Config ────────────────────────────────────────────────────────────────────
const FR_KEY   = process.env.FR_AUTH_KEY;
const FR_TOKEN = process.env.FR_AUTH_TOKEN;
const FR_HOST  = process.env.FR_HOST || "ecoarmor.fieldroutes.com";
const PORT     = process.env.PORT || 3000;

if (!FR_KEY || !FR_TOKEN) {
  console.error("Missing FR_AUTH_KEY or FR_AUTH_TOKEN environment variables.");
  process.exit(1);
}

const BASE_URL = `https://${FR_HOST}/api`;

// ── FieldRoutes API helper ────────────────────────────────────────────────────
async function frPost(endpoint, params = {}) {
  const body = new URLSearchParams({
    authenticationKey:   FR_KEY,
    authenticationToken: FR_TOKEN,
    ...params,
  });

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });

  if (!res.ok) {
    throw new Error(`FieldRoutes API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();

  if (data.success === false) {
    throw new Error(`FieldRoutes error: ${data.errorMessage || JSON.stringify(data)}`);
  }

  return data;
}

// Two-step helper: search → get with includeData
async function searchAndGet(entity, searchParams) {
  const searchResult = await frPost(`/${entity}/search`, {
    ...searchParams,
    includeData: 1,
  });
  return searchResult;
}

// ── Build MCP server ──────────────────────────────────────────────────────────
function buildServer() {
  const server = new McpServer({
    name:    "fieldroutes",
    version: "1.0.0",
  });

  // ── 1. search_customer ──────────────────────────────────────────────────────
  server.tool(
    "search_customer",
    "Search for customers by name, phone, email, address, or city. Returns matching customer records.",
    {
      fname:   z.string().optional().describe("First name (partial match supported)"),
      lname:   z.string().optional().describe("Last name (partial match supported)"),
      phone:   z.string().optional().describe("Phone number"),
      email:   z.string().optional().describe("Email address"),
      address: z.string().optional().describe("Street address"),
      city:    z.string().optional().describe("City"),
      zip:     z.string().optional().describe("ZIP code"),
      status:  z.enum(["0", "1"]).optional().describe("1 = active, 0 = inactive"),
    },
    async (args) => {
      const params = {};
      if (args.fname)   params.fname   = JSON.stringify({ operator: "CONTAINS", value: args.fname });
      if (args.lname)   params.lname   = JSON.stringify({ operator: "CONTAINS", value: args.lname });
      if (args.phone)   params.phone   = args.phone;
      if (args.email)   params.email   = args.email;
      if (args.address) params.address = JSON.stringify({ operator: "CONTAINS", value: args.address });
      if (args.city)    params.city    = JSON.stringify({ operator: "CONTAINS", value: args.city });
      if (args.zip)     params.zip     = args.zip;
      if (args.status)  params.status  = args.status;

      const data = await searchAndGet("customer", params);
      const customers = data.customers || [];

      if (customers.length === 0) {
        return { content: [{ type: "text", text: "No customers found matching those criteria." }] };
      }

      const summary = customers.slice(0, 20).map((c) => ({
        customerID: c.customerID,
        name:       `${c.fname} ${c.lname}`,
        phone:      c.phone,
        email:      c.email,
        address:    `${c.address}, ${c.city}, ${c.state} ${c.zip}`,
        status:     c.status === "1" ? "Active" : "Inactive",
        balance:    `$${c.balance}`,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // ── 2. get_customer ─────────────────────────────────────────────────────────
  server.tool(
    "get_customer",
    "Get full account details for a specific customer by their customerID.",
    {
      customerID: z.string().describe("The FieldRoutes customer ID"),
    },
    async ({ customerID }) => {
      const data = await frPost("/customer/get", { customerIDs: customerID });
      const customers = data.customers || [];

      if (customers.length === 0) {
        return { content: [{ type: "text", text: `No customer found with ID ${customerID}.` }] };
      }

      const c = customers[0];
      const detail = {
        customerID:    c.customerID,
        name:          `${c.fname} ${c.lname}`,
        phone:         c.phone,
        altPhone:      c.altPhone,
        email:         c.email,
        address:       `${c.address}, ${c.city}, ${c.state} ${c.zip}`,
        balance:       `$${c.balance}`,
        status:        c.status === "1" ? "Active" : "Inactive",
        dateAdded:     c.dateAdded,
        source:        c.sourceID,
        notes:         c.customerNotes,
        preferredTech: c.preferredTechID,
        lat:           c.lat,
        lng:           c.lng,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
      };
    }
  );

  // ── 3. get_appointments ─────────────────────────────────────────────────────
  server.tool(
    "get_appointments",
    "Get appointments for a customer. Can filter by date range and status.",
    {
      customerID: z.string().optional().describe("FieldRoutes customer ID"),
      status:     z.enum(["0", "1", "2"]).optional().describe("0=pending, 1=complete, 2=cancelled"),
      dateStart:  z.string().optional().describe("Start date YYYY-MM-DD"),
      dateEnd:    z.string().optional().describe("End date YYYY-MM-DD"),
      employeeID: z.string().optional().describe("Filter by technician employee ID"),
    },
    async (args) => {
      const params = {};
      if (args.customerID) params.customerIDs = args.customerID;
      if (args.status)     params.status       = args.status;
      if (args.employeeID) params.employeeIDs  = args.employeeID;
      if (args.dateStart || args.dateEnd) {
        if (args.dateStart && args.dateEnd) {
          params.date = JSON.stringify({ operator: "BETWEEN", value: [args.dateStart, args.dateEnd] });
        } else if (args.dateStart) {
          params.date = JSON.stringify({ operator: ">=", value: args.dateStart });
        } else {
          params.date = JSON.stringify({ operator: "<=", value: args.dateEnd });
        }
      }

      const data = await searchAndGet("appointment", params);
      const appts = data.appointments || [];

      if (appts.length === 0) {
        return { content: [{ type: "text", text: "No appointments found." }] };
      }

      const summary = appts.slice(0, 25).map((a) => ({
        appointmentID: a.appointmentID,
        customerID:    a.customerID,
        date:          a.date,
        start:         a.start,
        end:           a.end,
        status:        a.status === "1" ? "Complete" : a.status === "2" ? "Cancelled" : "Pending",
        techID:        a.employeeID,
        type:          a.type,
        notes:         a.officeNotes,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // ── 4. get_subscriptions ────────────────────────────────────────────────────
  server.tool(
    "get_subscriptions",
    "Get active service plan subscriptions for a customer.",
    {
      customerID: z.string().optional().describe("FieldRoutes customer ID"),
      status:     z.enum(["0", "1"]).optional().describe("1 = active, 0 = inactive"),
    },
    async (args) => {
      const params = {};
      if (args.customerID) params.customerIDs = args.customerID;
      if (args.status)     params.status       = args.status;
      else                 params.status       = "1"; // default to active

      const data = await searchAndGet("subscription", params);
      const subs = data.subscriptions || [];

      if (subs.length === 0) {
        return { content: [{ type: "text", text: "No subscriptions found." }] };
      }

      const summary = subs.slice(0, 25).map((s) => ({
        subscriptionID:  s.subscriptionID,
        customerID:      s.customerID,
        status:          s.status === "1" ? "Active" : "Inactive",
        serviceType:     s.serviceType,
        recurringCharge: `$${s.recurringCharge}`,
        frequency:       s.frequency,
        nextService:     s.nextService,
        soldBy:          s.soldBy,
        dateAdded:       s.dateAdded,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // ── 5. get_tickets ──────────────────────────────────────────────────────────
  server.tool(
    "get_tickets",
    "Get invoices (tickets) for a customer. Can filter by status and date range.",
    {
      customerID:     z.string().optional().describe("FieldRoutes customer ID"),
      status:         z.enum(["0", "1"]).optional().describe("1 = active, 0 = inactive"),
      subscriptionID: z.string().optional().describe("Filter by subscription ID"),
      dateStart:      z.string().optional().describe("Invoice date start YYYY-MM-DD"),
      dateEnd:        z.string().optional().describe("Invoice date end YYYY-MM-DD"),
    },
    async (args) => {
      const params = {};
      if (args.customerID)     params.customerIDs     = args.customerID;
      if (args.status)         params.status           = args.status;
      if (args.subscriptionID) params.subscriptionIDs  = args.subscriptionID;
      if (args.dateStart || args.dateEnd) {
        if (args.dateStart && args.dateEnd) {
          params.dateCreated = JSON.stringify({ operator: "BETWEEN", value: [args.dateStart, args.dateEnd] });
        } else if (args.dateStart) {
          params.dateCreated = JSON.stringify({ operator: ">=", value: args.dateStart });
        } else {
          params.dateCreated = JSON.stringify({ operator: "<=", value: args.dateEnd });
        }
      }

      const data = await searchAndGet("ticket", params);
      const tickets = data.tickets || [];

      if (tickets.length === 0) {
        return { content: [{ type: "text", text: "No tickets/invoices found." }] };
      }

      const summary = tickets.slice(0, 25).map((t) => ({
        ticketID:       t.ticketID,
        customerID:     t.customerID,
        subscriptionID: t.subscriptionID,
        appointmentID:  t.appointmentID,
        dateCreated:    t.dateCreated,
        subTotal:       `$${t.subTotal}`,
        taxAmount:      `$${t.taxAmount}`,
        total:          `$${t.total}`,
        balance:        `$${t.balance}`,
        status:         t.status === "1" ? "Active" : "Inactive",
        templateType:   t.templateType === "I" ? "Initial" : t.templateType === "R" ? "Recurring" : "Standalone",
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // ── 6. get_payments ─────────────────────────────────────────────────────────
  server.tool(
    "get_payments",
    "Get payment history for a customer or ticket.",
    {
      customerID: z.string().optional().describe("FieldRoutes customer ID"),
      ticketID:   z.string().optional().describe("Filter by ticket/invoice ID"),
      dateStart:  z.string().optional().describe("Payment date start YYYY-MM-DD"),
      dateEnd:    z.string().optional().describe("Payment date end YYYY-MM-DD"),
    },
    async (args) => {
      const params = {};
      if (args.customerID) params.customerIDs = args.customerID;
      if (args.ticketID)   params.ticketIDs   = args.ticketID;
      if (args.dateStart || args.dateEnd) {
        if (args.dateStart && args.dateEnd) {
          params.date = JSON.stringify({ operator: "BETWEEN", value: [args.dateStart, args.dateEnd] });
        } else if (args.dateStart) {
          params.date = JSON.stringify({ operator: ">=", value: args.dateStart });
        } else {
          params.date = JSON.stringify({ operator: "<=", value: args.dateEnd });
        }
      }

      const data = await searchAndGet("payment", params);
      const payments = data.payments || [];

      if (payments.length === 0) {
        return { content: [{ type: "text", text: "No payments found." }] };
      }

      const summary = payments.slice(0, 25).map((p) => ({
        paymentID:   p.paymentID,
        customerID:  p.customerID,
        ticketID:    p.ticketID,
        date:        p.date,
        amount:      `$${p.amount}`,
        paymentType: p.paymentMethod,
        status:      p.status,
        appliedBy:   p.employeeID,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // ── 7. add_note ─────────────────────────────────────────────────────────────
  server.tool(
    "add_note",
    "Add a note to a customer account in FieldRoutes.",
    {
      customerID: z.string().describe("FieldRoutes customer ID"),
      note:       z.string().describe("The note text to add to the account"),
    },
    async ({ customerID, note }) => {
      const data = await frPost("/note/create", {
        customerID,
        notes: note,
        cancelService: 0,
      });

      return {
        content: [{
          type: "text",
          text: data.success
            ? `Note added successfully to customer ${customerID}. Note ID: ${data.noteID}`
            : `Failed to add note: ${data.errorMessage}`,
        }],
      };
    }
  );

  return server;
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server    = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => transport.close());

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "EcoArmor FieldRoutes MCP Server" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FieldRoutes MCP server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
