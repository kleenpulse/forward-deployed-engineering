// Lesson 5 exercise: an MCP server over a legacy SOAP system.
// Run: bun exercises/0005-mcp/start.ts
//
// This file is both the server and the test. Run it plainly and harness.ts starts the fake
// legacy system, then starts this same file with "serve" as an MCP server over stdio and
// speaks JSON-RPC to it, the way an agent would. Your job: make every check print PASS.
import { PROTOCOL_VERSION, STATUS_CODES, parseFault, pick, runChecks, soapRequest } from "./harness.ts";

const LEGACY_URL = process.env.LEGACY_URL ?? "";
const LEGACY_API_KEY = process.env.LEGACY_API_KEY ?? "";

type Msg = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };
type Reply = { result: any } | { error: { code: number; message: string; data?: unknown } };

const send = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");

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

// The deliberately naive tool: it works in a demo and fails at a real customer.
async function callTool(params: any): Promise<Reply> {
  if (params?.name !== "get_order") throw new Error(`no such tool ${params?.name}`);
  const headers = { "content-type": "application/soap+xml; charset=utf-8", "x-api-key": LEGACY_API_KEY };
  console.log("[debug] calling legacy", LEGACY_URL, headers);
  const res = await fetch(LEGACY_URL, {
    method: "POST",
    headers,
    body: soapRequest("GetOrder", { OrderId: String(params.arguments?.order_id) }),
  });
  // Whatever came back, XML, a fault or a 429, goes straight to the model.
  return { result: { resultType: "complete", content: [{ type: "text", text: await res.text() }], isError: false } };
}

// TODO: make every check pass. In the order the checks print:
//   1. stdout is the protocol channel: write nothing else there. Log with console.error (stderr).
//   2. In handle(), check _meta on every request before anything else.
//      Missing protocolVersion or clientCapabilities -> error -32602.
//      A version you don't support -> error -32022 with data: { supported: [...], requested }.
//   3. Translate the SOAP reply into structuredContent:
//      { order_id, status, customer, total, currency }. status is a word from STATUS_CODES,
//      total is a number in whole units (129900 cents -> 1299). Also return it as JSON text.
//      Use pick(xml, "StatusCd") and friends. Never hand the model raw XML.
//   4. Unknown tool -> JSON-RPC error -32602. A badly formatted id, or an order that doesn't
//      exist (a Sender fault, see parseFault) -> a result with isError: true and one sentence
//      the model can act on. Say what a valid id looks like.
//   5. On 429, 503 or a Receiver fault, wait and try again: Retry-After seconds when the
//      response has that header, otherwise backoff that doubles each time. Add a little jitter.
//   6. At most 3 attempts in total. Then give up with isError: true and say to try later.
//   7. The API key comes from the environment and goes only into the X-Api-Key header.
// Spend 30 minutes before you open solution.ts.
void [STATUS_CODES, parseFault, pick];

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
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } });
  }
}

if (process.argv[2] === "serve") await serve();
else await runChecks(import.meta.path);
