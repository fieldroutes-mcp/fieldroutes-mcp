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

// ── Helpers ───────────────────────────────────────────────────────────────────
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
  if (!res.ok) throw new Error(`FieldRoutes API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.success === false) throw new Error(`FieldRoutes error: ${data.errorMessage || JSON.stringify(data)}`);
  return data;
}

async function searchAndGet(entity, searchParams) {
  return frPost(`/${entity}/search`, { ...searchParams, includeData: 1 });
}

function dateRange(start, end) {
  if (start && end) return JSON.stringify({ operator: "BETWEEN", value: [start, end] });
  if (start) return JSON.stringify({ operator: ">=", value: start });
  if (end)   return JSON.stringify({ operator: "<=", value: end });
  return null;
}

function contains(val) {
  return JSON.stringify({ operator: "CONTAINS", value: val });
}

function ok(text) {
  return { content: [{ type: "text", text }] };
}

// ── Server ────────────────────────────────────────────────────────────────────
function buildServer() {
  const server = new McpServer({ name: "fieldroutes", version: "2.0.0" });

  // ── CUSTOMERS ──────────────────────────────────────────────────────────────

  server.tool("search_customer",
    "Search customers by name, phone, email, address, city, zip, or status.",
    {
      fname:   z.string().optional(),
      lname:   z.string().optional(),
      phone:   z.string().optional(),
      email:   z.string().optional(),
      address: z.string().optional(),
      city:    z.string().optional(),
      zip:     z.string().optional(),
      status:  z.enum(["0","1"]).optional().describe("1=active, 0=inactive"),
    },
    async (args) => {
      const p = {};
      if (args.fname)   p.fname   = contains(args.fname);
      if (args.lname)   p.lname   = contains(args.lname);
      if (args.phone)   p.phone   = args.phone;
      if (args.email)   p.email   = args.email;
      if (args.address) p.address = contains(args.address);
      if (args.city)    p.city    = contains(args.city);
      if (args.zip)     p.zip     = args.zip;
      if (args.status)  p.status  = args.status;
      const data = await searchAndGet("customer", p);
      const list = (data.customers || []).slice(0, 25).map(c => ({
        customerID: c.customerID, name: `${c.fname} ${c.lname}`,
        phone: c.phone, email: c.email,
        address: `${c.address}, ${c.city}, ${c.state} ${c.zip}`,
        status: c.status === "1" ? "Active" : "Inactive",
        balance: `$${c.balance}`,
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No customers found.");
    }
  );

  server.tool("get_customer",
    "Get full account details for a specific customer by customerID.",
    { customerID: z.string() },
    async ({ customerID }) => {
      const data = await frPost("/customer/get", { customerIDs: customerID });
      const c = (data.customers || [])[0];
      if (!c) return ok(`No customer found with ID ${customerID}.`);
      return ok(JSON.stringify({
        customerID: c.customerID, name: `${c.fname} ${c.lname}`,
        phone: c.phone, altPhone: c.altPhone, email: c.email,
        address: `${c.address}, ${c.city}, ${c.state} ${c.zip}`,
        balance: `$${c.balance}`, status: c.status === "1" ? "Active" : "Inactive",
        dateAdded: c.dateAdded, source: c.sourceID,
        notes: c.customerNotes, preferredTech: c.preferredTechID,
      }, null, 2));
    }
  );

  server.tool("get_new_customers",
    "Get customers added within a date range.",
    {
      dateStart: z.string().describe("YYYY-MM-DD"),
      dateEnd:   z.string().describe("YYYY-MM-DD"),
    },
    async ({ dateStart, dateEnd }) => {
      const data = await searchAndGet("customer", { dateAdded: dateRange(dateStart, dateEnd) });
      const list = data.customers || [];
      return ok(`${list.length} new customers (${dateStart} to ${dateEnd})\n\n` +
        JSON.stringify(list.slice(0, 50).map(c => ({
          customerID: c.customerID, name: `${c.fname} ${c.lname}`,
          phone: c.phone, email: c.email, city: c.city,
          dateAdded: c.dateAdded, source: c.sourceID,
        })), null, 2));
    }
  );

  server.tool("get_customers_with_balance",
    "Get active customers with an outstanding balance.",
    { minBalance: z.string().optional().describe("Minimum balance, default 1") },
    async ({ minBalance = "1" }) => {
      const data = await searchAndGet("customer", {
        status: "1",
        balance: JSON.stringify({ operator: ">=", value: minBalance }),
      });
      const list = data.customers || [];
      const total = list.reduce((s, c) => s + parseFloat(c.balance || 0), 0);
      return ok(`${list.length} customers with balance >= $${minBalance}. Total AR: $${total.toFixed(2)}\n\n` +
        JSON.stringify(list.slice(0, 50).map(c => ({
          customerID: c.customerID, name: `${c.fname} ${c.lname}`,
          phone: c.phone, balance: `$${c.balance}`, city: c.city,
        })), null, 2));
    }
  );

  // ── APPOINTMENTS ───────────────────────────────────────────────────────────

  server.tool("get_appointments",
    "Get appointments filtered by customer, date range, technician, or status.",
    {
      customerID: z.string().optional(),
      employeeID: z.string().optional(),
      status:     z.enum(["0","1","2"]).optional().describe("0=pending, 1=complete, 2=cancelled"),
      dateStart:  z.string().optional().describe("YYYY-MM-DD"),
      dateEnd:    z.string().optional().describe("YYYY-MM-DD"),
    },
    async (args) => {
      const p = {};
      if (args.customerID) p.customerIDs = args.customerID;
      if (args.employeeID) p.employeeIDs = args.employeeID;
      if (args.status)     p.status = args.status;
      const dr = dateRange(args.dateStart, args.dateEnd);
      if (dr) p.date = dr;
      const data = await searchAndGet("appointment", p);
      const list = (data.appointments || []).slice(0, 50).map(a => ({
        appointmentID: a.appointmentID, customerID: a.customerID,
        date: a.date, start: a.start, end: a.end,
        status: a.status === "1" ? "Complete" : a.status === "2" ? "Cancelled" : "Pending",
        techID: a.employeeID, type: a.type, notes: a.officeNotes,
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No appointments found.");
    }
  );

  server.tool("get_weekly_appointments",
    "Get appointment summary stats for a given week.",
    {
      dateStart: z.string().describe("YYYY-MM-DD"),
      dateEnd:   z.string().describe("YYYY-MM-DD"),
    },
    async ({ dateStart, dateEnd }) => {
      const data = await searchAndGet("appointment", { date: dateRange(dateStart, dateEnd) });
      const appts = data.appointments || [];
      const completed = appts.filter(a => a.status === "1").length;
      const cancelled = appts.filter(a => a.status === "2").length;
      const pending   = appts.filter(a => a.status === "0").length;
      const byTech = {};
      appts.forEach(a => {
        const t = a.employeeID || "Unassigned";
        byTech[t] = (byTech[t] || 0) + 1;
      });
      return ok(`Appointment Summary (${dateStart} to ${dateEnd})\n` +
        `Total: ${appts.length} | Completed: ${completed} | Cancelled: ${cancelled} | Pending: ${pending}\n\n` +
        `By Technician:\n${Object.entries(byTech).map(([k,v]) => `  Tech ${k}: ${v}`).join("\n")}`);
    }
  );

  // ── SUBSCRIPTIONS ──────────────────────────────────────────────────────────

  server.tool("get_subscriptions",
    "Get service plan subscriptions for a customer or all active subscriptions.",
    {
      customerID: z.string().optional(),
      status:     z.enum(["0","1"]).optional().describe("1=active, 0=inactive"),
    },
    async (args) => {
      const p = { status: args.status || "1" };
      if (args.customerID) p.customerIDs = args.customerID;
      const data = await searchAndGet("subscription", p);
      const list = (data.subscriptions || []).slice(0, 50).map(s => ({
        subscriptionID: s.subscriptionID, customerID: s.customerID,
        status: s.status === "1" ? "Active" : "Inactive",
        serviceType: s.serviceType, recurringCharge: `$${s.recurringCharge}`,
        frequency: s.frequency, nextService: s.nextService,
        soldBy: s.soldBy, dateAdded: s.dateAdded,
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No subscriptions found.");
    }
  );

  server.tool("get_new_subscriptions",
    "Get new subscriptions added within a date range.",
    {
      dateStart: z.string().describe("YYYY-MM-DD"),
      dateEnd:   z.string().describe("YYYY-MM-DD"),
    },
    async ({ dateStart, dateEnd }) => {
      const data = await searchAndGet("subscription", { dateAdded: dateRange(dateStart, dateEnd) });
      const list = data.subscriptions || [];
      const revenue = list.reduce((s, sub) => s + parseFloat(sub.recurringCharge || 0), 0);
      return ok(`${list.length} new subscriptions (${dateStart} to ${dateEnd})\n` +
        `New recurring revenue: $${revenue.toFixed(2)}/period\n\n` +
        JSON.stringify(list.slice(0, 50).map(s => ({
          subscriptionID: s.subscriptionID, customerID: s.customerID,
          serviceType: s.serviceType, recurringCharge: `$${s.recurringCharge}`,
          soldBy: s.soldBy, dateAdded: s.dateAdded,
        })), null, 2));
    }
  );

  server.tool("get_cancelled_subscriptions",
    "Get subscriptions cancelled within a date range.",
    {
      dateStart: z.string().describe("YYYY-MM-DD"),
      dateEnd:   z.string().describe("YYYY-MM-DD"),
    },
    async ({ dateStart, dateEnd }) => {
      const data = await searchAndGet("subscription", {
        status: "0",
        dateCancelled: dateRange(dateStart, dateEnd),
      });
      const list = data.subscriptions || [];
      return ok(`${list.length} cancellations (${dateStart} to ${dateEnd})\n\n` +
        JSON.stringify(list.slice(0, 50).map(s => ({
          subscriptionID: s.subscriptionID, customerID: s.customerID,
          serviceType: s.serviceType, recurringCharge: `$${s.recurringCharge}`,
          dateCancelled: s.dateCancelled, cancellationReason: s.cancellationReason,
        })), null, 2));
    }
  );

  // ── TICKETS / INVOICES ─────────────────────────────────────────────────────

  server.tool("get_tickets",
    "Get invoices for a customer or by date range.",
    {
      customerID:     z.string().optional(),
      subscriptionID: z.string().optional(),
      status:         z.enum(["0","1"]).optional(),
      dateStart:      z.string().optional().describe("YYYY-MM-DD"),
      dateEnd:        z.string().optional().describe("YYYY-MM-DD"),
    },
    async (args) => {
      const p = {};
      if (args.customerID)     p.customerIDs    = args.customerID;
      if (args.subscriptionID) p.subscriptionIDs = args.subscriptionID;
      if (args.status)         p.status          = args.status;
      const dr = dateRange(args.dateStart, args.dateEnd);
      if (dr) p.dateCreated = dr;
      const data = await searchAndGet("ticket", p);
      const list = (data.tickets || []).slice(0, 50).map(t => ({
        ticketID: t.ticketID, customerID: t.customerID,
        dateCreated: t.dateCreated, total: `$${t.total}`,
        balance: `$${t.balance}`, status: t.status === "1" ? "Active" : "Inactive",
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No tickets found.");
    }
  );

  server.tool("get_outstanding_invoices",
    "Get all invoices with an outstanding balance.",
    { minBalance: z.string().optional().describe("Minimum balance, default 1") },
    async ({ minBalance = "1" }) => {
      const data = await searchAndGet("ticket", {
        status: "1",
        balance: JSON.stringify({ operator: ">=", value: minBalance }),
      });
      const list = data.tickets || [];
      const total = list.reduce((s, t) => s + parseFloat(t.balance || 0), 0);
      return ok(`${list.length} invoices with balance >= $${minBalance}. Total AR: $${total.toFixed(2)}\n\n` +
        JSON.stringify(list.slice(0, 50).map(t => ({
          ticketID: t.ticketID, customerID: t.customerID,
          dateCreated: t.dateCreated, total: `$${t.total}`, balance: `$${t.balance}`,
        })), null, 2));
    }
  );

  // ── PAYMENTS ───────────────────────────────────────────────────────────────

  server.tool("get_payments",
    "Get payment history for a customer or ticket.",
    {
      customerID: z.string().optional(),
      ticketID:   z.string().optional(),
      dateStart:  z.string().optional().describe("YYYY-MM-DD"),
      dateEnd:    z.string().optional().describe("YYYY-MM-DD"),
    },
    async (args) => {
      const p = {};
      if (args.customerID) p.customerIDs = args.customerID;
      if (args.ticketID)   p.ticketIDs   = args.ticketID;
      const dr = dateRange(args.dateStart, args.dateEnd);
      if (dr) p.date = dr;
      const data = await searchAndGet("payment", p);
      const list = (data.payments || []).slice(0, 50).map(p => ({
        paymentID: p.paymentID, customerID: p.customerID,
        ticketID: p.ticketID, date: p.date,
        amount: `$${p.amount}`, paymentMethod: p.paymentMethod,
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No payments found.");
    }
  );

  server.tool("get_weekly_revenue",
    "Get total revenue collected for a date range.",
    {
      dateStart: z.string().describe("YYYY-MM-DD"),
      dateEnd:   z.string().describe("YYYY-MM-DD"),
    },
    async ({ dateStart, dateEnd }) => {
      const data = await searchAndGet("payment", { date: dateRange(dateStart, dateEnd) });
      const payments = data.payments || [];
      const total = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
      const byMethod = {};
      payments.forEach(p => {
        const m = p.paymentMethod || "Unknown";
        byMethod[m] = (byMethod[m] || 0) + parseFloat(p.amount || 0);
      });
      return ok(`Revenue (${dateStart} to ${dateEnd})\n` +
        `Total: $${total.toFixed(2)} across ${payments.length} payments\n\n` +
        `By Method:\n${Object.entries(byMethod).map(([k,v]) => `  ${k}: $${v.toFixed(2)}`).join("\n")}`);
    }
  );

  // ── EMPLOYEES ──────────────────────────────────────────────────────────────

  server.tool("get_employees",
    "Get a list of employees and technicians.",
    { active: z.enum(["0","1"]).optional().describe("1=active, 0=inactive") },
    async (args) => {
      const p = {};
      if (args.active) p.active = args.active;
      const data = await searchAndGet("employee", p);
      const list = (data.employees || []).slice(0, 50).map(e => ({
        employeeID: e.employeeID, name: `${e.fname} ${e.lname}`,
        type: e.type, phone: e.phone, email: e.email,
        active: e.active === "1" ? "Active" : "Inactive",
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No employees found.");
    }
  );

  server.tool("get_technician_performance",
    "Get appointment stats for a technician over a date range.",
    {
      employeeID: z.string(),
      dateStart:  z.string().describe("YYYY-MM-DD"),
      dateEnd:    z.string().describe("YYYY-MM-DD"),
    },
    async ({ employeeID, dateStart, dateEnd }) => {
      const data = await searchAndGet("appointment", {
        employeeIDs: employeeID,
        date: dateRange(dateStart, dateEnd),
      });
      const appts = data.appointments || [];
      const completed = appts.filter(a => a.status === "1").length;
      const cancelled = appts.filter(a => a.status === "2").length;
      const pending   = appts.filter(a => a.status === "0").length;
      return ok(`Tech ${employeeID} Performance (${dateStart} to ${dateEnd})\n` +
        `Total: ${appts.length} | Completed: ${completed} | Cancelled: ${cancelled} | Pending: ${pending}\n` +
        `Completion Rate: ${appts.length ? ((completed/appts.length)*100).toFixed(1) : 0}%`);
    }
  );

  // ── NOTES ──────────────────────────────────────────────────────────────────

  server.tool("add_note",
    "Add a note to a customer account.",
    { customerID: z.string(), note: z.string() },
    async ({ customerID, note }) => {
      const data = await frPost("/note/create", { customerID, notes: note, cancelService: 0 });
      return ok(data.success
        ? `Note added to customer ${customerID}. Note ID: ${data.noteID}`
        : `Failed: ${data.errorMessage}`);
    }
  );

  server.tool("get_notes",
    "Get notes for a customer account.",
    { customerID: z.string() },
    async ({ customerID }) => {
      const data = await searchAndGet("note", { customerIDs: customerID });
      const list = (data.notes || []).slice(0, 25).map(n => ({
        noteID: n.noteID, date: n.dateAdded,
        note: n.notes, addedBy: n.employeeID,
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No notes found.");
    }
  );

  // ── ROUTES ─────────────────────────────────────────────────────────────────

  server.tool("get_routes",
    "Get routes for a date or date range.",
    {
      dateStart:  z.string().describe("YYYY-MM-DD"),
      dateEnd:    z.string().optional().describe("YYYY-MM-DD"),
      employeeID: z.string().optional(),
    },
    async (args) => {
      const p = {};
      const dr = dateRange(args.dateStart, args.dateEnd);
      if (dr) p.date = dr;
      if (args.employeeID) p.employeeIDs = args.employeeID;
      const data = await searchAndGet("route", p);
      const list = (data.routes || []).slice(0, 25).map(r => ({
        routeID: r.routeID, date: r.date,
        employeeID: r.employeeID, title: r.title,
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No routes found.");
    }
  );

  // ── LEADS ──────────────────────────────────────────────────────────────────

  server.tool("get_leads",
    "Get sales leads/door knock records.",
    {
      status:    z.string().optional(),
      dateStart: z.string().optional().describe("YYYY-MM-DD"),
      dateEnd:   z.string().optional().describe("YYYY-MM-DD"),
    },
    async (args) => {
      const p = {};
      if (args.status) p.status = args.status;
      const dr = dateRange(args.dateStart, args.dateEnd);
      if (dr) p.dateAdded = dr;
      const data = await searchAndGet("knockDoor", p);
      const list = (data.knockDoors || []).slice(0, 50).map(l => ({
        leadID: l.knockDoorID, name: `${l.fname} ${l.lname}`,
        address: l.address, city: l.city,
        phone: l.phone, status: l.status,
        dateAdded: l.dateAdded, assignedTo: l.employeeID,
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No leads found.");
    }
  );

  // ── CHEMICAL USAGE ─────────────────────────────────────────────────────────

  server.tool("get_chemical_usage",
    "Get chemical/product usage records.",
    {
      customerID: z.string().optional(),
      dateStart:  z.string().optional().describe("YYYY-MM-DD"),
      dateEnd:    z.string().optional().describe("YYYY-MM-DD"),
    },
    async (args) => {
      const p = {};
      if (args.customerID) p.customerIDs = args.customerID;
      const dr = dateRange(args.dateStart, args.dateEnd);
      if (dr) p.date = dr;
      const data = await searchAndGet("chemicalUsage", p);
      const list = (data.chemicalUsages || []).slice(0, 50).map(c => ({
        chemicalUsageID: c.chemicalUsageID, customerID: c.customerID,
        date: c.date, product: c.product,
        amount: c.amount, unit: c.unit, techID: c.employeeID,
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No chemical usage records found.");
    }
  );

  // ── DOCUMENTS ──────────────────────────────────────────────────────────────

  server.tool("get_documents",
    "Get documents attached to a customer account.",
    { customerID: z.string() },
    async ({ customerID }) => {
      const data = await searchAndGet("document", { customerIDs: customerID });
      const list = (data.documents || []).slice(0, 25).map(d => ({
        documentID: d.documentID, filename: d.filename,
        dateAdded: d.dateAdded, description: d.description,
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No documents found.");
    }
  );

  // ── FLAGS ──────────────────────────────────────────────────────────────────

  server.tool("get_flags",
    "Get custom flags/tags on a customer account.",
    { customerID: z.string() },
    async ({ customerID }) => {
      const data = await searchAndGet("genericFlag", { customerIDs: customerID });
      const list = (data.genericFlags || []).map(f => ({
        flagID: f.genericFlagID, customerID: f.customerID,
        flag: f.flag, dateAdded: f.dateAdded,
      }));
      return ok(list.length ? JSON.stringify(list, null, 2) : "No flags found.");
    }
  );

  // ── WEEKLY REPORT (composite) ──────────────────────────────────────────────

  server.tool("get_weekly_report",
    "Full weekly business report: revenue, appointments, new customers, subscriptions, and cancellations.",
    {
      dateStart: z.string().describe("Week start YYYY-MM-DD"),
      dateEnd:   z.string().describe("Week end YYYY-MM-DD"),
    },
    async ({ dateStart, dateEnd }) => {
      const dr = dateRange(dateStart, dateEnd);
      const [paymentsData, apptsData, customersData, newSubsData, cancelSubsData] = await Promise.all([
        searchAndGet("payment",      { date: dr }),
        searchAndGet("appointment",  { date: dr }),
        searchAndGet("customer",     { dateAdded: dr }),
        searchAndGet("subscription", { dateAdded: dr }),
        searchAndGet("subscription", { status: "0", dateCancelled: dr }),
      ]);

      const payments   = paymentsData.payments        || [];
      const appts      = apptsData.appointments        || [];
      const customers  = customersData.customers       || [];
      const newSubs    = newSubsData.subscriptions     || [];
      const cancelSubs = cancelSubsData.subscriptions  || [];

      const revenue      = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
      const completed    = appts.filter(a => a.status === "1").length;
      const cancelled    = appts.filter(a => a.status === "2").length;
      const newRecurring = newSubs.reduce((s, sub) => s + parseFloat(sub.recurringCharge || 0), 0);

      return ok(
        `═══════════════════════════════════════\n` +
        `  ECOARMOR WEEKLY REPORT\n` +
        `  ${dateStart} to ${dateEnd}\n` +
        `═══════════════════════════════════════\n\n` +
        `💰 REVENUE\n` +
        `  Collected: $${revenue.toFixed(2)}\n` +
        `  Payments processed: ${payments.length}\n\n` +
        `📅 APPOINTMENTS\n` +
        `  Total: ${appts.length}\n` +
        `  Completed: ${completed}\n` +
        `  Cancelled: ${cancelled}\n` +
        `  Completion rate: ${appts.length ? ((completed/appts.length)*100).toFixed(1) : 0}%\n\n` +
        `👥 CUSTOMERS\n` +
        `  New customers: ${customers.length}\n\n` +
        `📋 SUBSCRIPTIONS\n` +
        `  New: ${newSubs.length} (+$${newRecurring.toFixed(2)}/period)\n` +
        `  Cancelled: ${cancelSubs.length}\n` +
        `  Net change: ${newSubs.length - cancelSubs.length}\n`
      );
    }
  );

  return server;
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server    = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "EcoArmor FieldRoutes MCP Server",
    version: "2.0.0",
    tools: 23,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FieldRoutes MCP v2.0 running on port ${PORT}`);
});
