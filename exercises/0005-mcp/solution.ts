// Lesson 5 exercise, worked solution. Run: bun exercises/0005-mcp/solution.ts
// Try start.ts yourself first.
import { PROTOCOL_VERSION, STATUS_CODES, parseFault, pick, runChecks, soapRequest } from "./harness.ts";

// A local (stdio) MCP server takes its credentials from the environment, not from the
// model and not from tool arguments.
const LEGACY_URL = process.env.LEGACY_URL ?? "";
const LEGACY_API_KEY = process.env.LEGACY_API_KEY ?? "";
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 5_000; // if the system asks for a longer wait, give up and say so

type Msg = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };
type Reply = { result: any } | { error: { code: number; message: string; data?: unknown } };

// stdout is the protocol channel. Every byte written there must be a JSON-RPC message.
const send = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
// Logs go to stderr. Never log headers: one of them holds the API key.
const log = (...a: unknown[]) => console.error("[orders-mcp]", ...a);

const TOOLS = [
  {
    name: "get_order",
    title: "Look up an order",
    description:
      "Look up one customer order in the order system by its id. Returns the status (open, backordered, " +
      "shipped or cancelled), the customer's name, the order total and its currency. Order ids look like " +
      "A-1001. Use this to answer questions about a specific order; it can't search or change orders.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string", description: "The order id, for example A-1001", pattern: "^A-\\d{4}$" } },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
];

async function handle(msg: Msg): Promise<Reply> {
  // MCP is stateless: every request says which protocol version it speaks. Check it every time.
  const meta = msg.params?._meta;
  const version = meta?.["io.modelcontextprotocol/protocolVersion"];
  if (typeof version !== "string" || typeof meta?.["io.modelcontextprotocol/clientCapabilities"] !== "object")
    return { error: { code: -32602, message: "Invalid params: _meta needs io.modelcontextprotocol/protocolVersion and clientCapabilities" } };
  if (version !== PROTOCOL_VERSION)
    return { error: { code: -32022, message: "Unsupported protocol version", data: { supported: [PROTOCOL_VERSION], requested: version } } };

  switch (msg.method) {
    case "server/discover":
      return { result: {
        resultType: "complete",
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "orders-mcp", version: "1.0.0" } },
        instructions: "Read-only access to the customer's order system.",
        ttlMs: 3_600_000,
        cacheScope: "public",
      } };
    case "tools/list":
      return { result: { resultType: "complete", tools: TOOLS, ttlMs: 3_600_000, cacheScope: "public" } };
    case "tools/call":
      return callTool(msg.params);
    default:
      return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

// A failed tool run is a normal result with isError: true, written so the model can act on it.
const toolError = (text: string): Reply => ({ result: { resultType: "complete", content: [{ type: "text", text }], isError: true } });

async function callTool(params: any): Promise<Reply> {
  // A tool that doesn't exist is a broken request: a JSON-RPC protocol error.
  if (params?.name !== "get_order") return { error: { code: -32602, message: `Unknown tool: ${params?.name}` } };

  const id = String(params.arguments?.order_id ?? "").trim();
  if (!/^A-\d{4}$/.test(id)) return toolError(`"${id}" is not an order id. Order ids look like A-1001.`);

  const r = await callLegacy("GetOrder", { OrderId: id });
  if (r.kind === "ok") {
    const order = {
      order_id: pick(r.xml, "OrderId"),
      status: STATUS_CODES[pick(r.xml, "StatusCd") ?? ""] ?? "unknown",
      customer: pick(r.xml, "CustNm"),
      total: Number(pick(r.xml, "TotAmtCents")) / 100,
      currency: pick(r.xml, "CurrCd"),
    };
    return { result: { resultType: "complete", content: [{ type: "text", text: JSON.stringify(order) }], structuredContent: order, isError: false } };
  }
  if (r.kind === "fault" && r.fault.subcode === "OrderNotFound")
    return toolError(`There is no order ${id} in the order system. Check the id with the customer; ids look like A-1001.`);
  if (r.kind === "fault") return toolError(`The order system rejected the request: ${r.fault.reason}.`);
  return toolError(`The order system is busy or down (${r.why}). Nothing was changed. Try again in a few minutes.`);
}

type Legacy = { kind: "ok"; xml: string } | { kind: "fault"; fault: NonNullable<ReturnType<typeof parseFault>> } | { kind: "unavailable"; why: string };

// GetOrder only reads, so repeating it is safe. Don't reuse this loop for a call that changes
// data unless the system gives you a way to make the retry idempotent.
async function callLegacy(operation: string, fields: Record<string, string>): Promise<Legacy> {
  for (let attempt = 1; ; attempt++) {
    let status = 0;
    let body = "";
    let retryAfter: string | null = null;
    try {
      const res = await fetch(LEGACY_URL, {
        method: "POST",
        headers: { "content-type": "application/soap+xml; charset=utf-8", "x-api-key": LEGACY_API_KEY },
        body: soapRequest(operation, fields),
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      body = await res.text();
      retryAfter = res.headers.get("retry-after");
    } catch (e) {
      log(operation, "network error:", (e as Error).message);
    }
    log(operation, fields, "->", status || "no response", `(attempt ${attempt})`);

    if (status === 200) return { kind: "ok", xml: body };
    const fault = parseFault(body);
    // Sender faults and other 4xx: the request itself is wrong. Sending it again won't help.
    const mayWorkLater = status === 0 || status === 429 || status === 503 || fault?.code === "Receiver";
    if (!mayWorkLater) return fault ? { kind: "fault", fault } : { kind: "unavailable", why: `HTTP ${status}` };

    const wait = waitMs(retryAfter, attempt);
    if (attempt >= MAX_ATTEMPTS || wait > MAX_WAIT_MS)
      return { kind: "unavailable", why: `${status ? `HTTP ${status}` : "no response"} after ${attempt} tries` };
    await Bun.sleep(wait);
  }
}

// Retry-After wins when the system sends it (seconds, or an HTTP date). Otherwise use capped
// exponential backoff. Either way, add jitter so parallel callers don't all return at once.
function waitMs(retryAfter: string | null, attempt: number): number {
  const jitter = Math.random() * 250;
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000 + jitter;
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now()) + jitter;
  return Math.min(250 * 2 ** (attempt - 1), 4_000) + jitter;
}

// The stdio transport: one JSON-RPC message per line on stdin, one per line on stdout.
async function serve() {
  const inFlight = new Set<Promise<void>>();
  for await (const line of console) {
    if (!line.trim()) continue;
    const p = onLine(line); // don't await: requests can run side by side
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  }
  await Promise.all(inFlight); // stdin closed: finish what's running, then exit
  process.exit(0);
}

async function onLine(line: string) {
  let msg: Msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return void send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (msg.id === undefined || msg.id === null) return; // a notification: never reply
  try {
    send({ jsonrpc: "2.0", id: msg.id, ...(await handle(msg)) });
  } catch (e) {
    log("internal error:", e);
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } });
  }
}

if (process.argv[2] === "serve") await serve();
else await runChecks(import.meta.path);
