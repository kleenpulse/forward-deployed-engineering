// Shared setup and checks for the Lesson 5 exercise. You don't need to edit this file.
//
// It plays both neighbours of your MCP server:
//   - the customer's legacy order system: SOAP 1.2 over HTTP, with an API key and a rate limit;
//   - the agent's MCP client: it starts your server as a subprocess and speaks JSON-RPC to it
//     over stdin and stdout, one message per line, the way a real MCP client would.
// start.ts and solution.ts import the constants, the XML helpers and runChecks() from here.

export const PROTOCOL_VERSION = "2026-07-28";

// ---------------------------------------------------------------------------------------------
// From the vendor's manual ("OrderService v1", 2009). The status codes GetOrder returns:
export const STATUS_CODES: Record<string, string> = {
  OPEN: "open",
  BCKORD: "backordered",
  SHPD: "shipped",
  CNCL: "cancelled",
};
// Order ids look like A-1001: the letter A, a hyphen, four digits.
// Errors come back as SOAP faults. Sender = "your request is wrong, don't resend it unchanged".
// Receiver = "our side failed, it may work later". The gateway in front also sends plain
// HTTP 429 (too many requests) and 503 (down for maintenance), both with a Retry-After header.

// ---------------------------------------------------------------------------------------------
// XML helpers for your server. They are just good enough for this one service.

const ENV_NS = "http://www.w3.org/2003/05/soap-envelope";
const APP_NS = "urn:example:orders:v1";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** A SOAP 1.2 request envelope, e.g. soapRequest("GetOrder", { OrderId: "A-1001" }). */
export function soapRequest(operation: string, fields: Record<string, string>): string {
  const inner = Object.entries(fields).map(([k, v]) => `<m:${k}>${esc(v)}</m:${k}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n<env:Envelope xmlns:env="${ENV_NS}" xmlns:m="${APP_NS}"><env:Body><m:${operation}>${inner}</m:${operation}></env:Body></env:Envelope>`;
}

/** The text inside the first <prefix:Tag>...</prefix:Tag>, or undefined. */
export function pick(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${tag}>`));
  return m ? unesc(m[1]) : undefined;
}

/** If the body is a SOAP fault: its code ("Sender" or "Receiver"), subcode and reason. */
export function parseFault(xml: string): { code: string; subcode?: string; reason: string } | undefined {
  if (!/<(?:[\w-]+:)?Fault[\s>]/.test(xml)) return undefined;
  const values = [...xml.matchAll(/<(?:[\w-]+:)?Value>([^<]*)<\/(?:[\w-]+:)?Value>/g)].map((m) => m[1]);
  const local = (q?: string) => q?.split(":").pop();
  return { code: local(values[0]) ?? "Unknown", subcode: local(values[1]), reason: pick(xml, "Text") ?? "" };
}

// ---------------------------------------------------------------------------------------------
// The fake legacy system.

type Order = { status: string; customer: string; totalCents: number; currency: string };
const ORDERS: Record<string, Order> = {
  "A-1001": { status: "SHPD", customer: "Brightwater Bikes", totalCents: 129900, currency: "EUR" },
  "A-1002": { status: "BCKORD", customer: "Halden Dental Supply", totalCents: 48250, currency: "EUR" },
  "A-1003": { status: "OPEN", customer: "Kestrel Garden Tools", totalCents: 7999, currency: "GBP" },
  "A-1004": { status: "SHPD", customer: "Larchmont Print Co.", totalCents: 315000, currency: "EUR" },
  "A-1005": { status: "CNCL", customer: "Ostrava Coffee Roasters", totalCents: 21000, currency: "EUR" },
};
const LIMIT_PER_SECOND = 3;

function envelope(body: string) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<env:Envelope xmlns:env="${ENV_NS}" xmlns:m="${APP_NS}">\n <env:Body>\n${body}\n </env:Body>\n</env:Envelope>`;
}
function fault(code: "Sender" | "Receiver", subcode: string, reason: string) {
  return envelope(`  <env:Fault>
   <env:Code><env:Value>env:${code}</env:Value><env:Subcode><env:Value>m:${subcode}</env:Value></env:Subcode></env:Code>
   <env:Reason><env:Text xml:lang="en">${esc(reason)}</env:Text></env:Reason>
  </env:Fault>`);
}
const soapXml = { "content-type": "application/soap+xml; charset=utf-8" };

function startLegacy(apiKey: string) {
  const state = {
    mode: "normal" as "normal" | "down",
    flaky: new Set<string>(), // order ids that fail once with a Receiver fault
    windowStart: 0,
    windowCount: 0,
    waitFrom: 0, // when we last told a caller to wait...
    waitUntil: 0, // ...and until when
    log: [] as { orderId?: string; status: number; keyOk: boolean }[],
    early: 0, // requests that arrived while the caller had been told to wait
  };
  const totals = { requests: 0, keyOk: 0 }; // across the whole run, never reset

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const now = Date.now();
      const body = await req.text();
      const orderId = pick(body, "OrderId");
      const keyOk = req.headers.get("x-api-key") === apiKey;
      const reply = (status: number, text: string, headers: Record<string, string> = soapXml) => {
        state.log.push({ orderId, status, keyOk });
        totals.requests++;
        if (keyOk) totals.keyOk++;
        return new Response(text, { status, headers });
      };

      // Arriving more than 100 ms after we said "wait", but before the wait is over, is early.
      if (now > state.waitFrom + 100 && now < state.waitUntil) state.early++;

      if (state.mode === "down") {
        state.waitFrom = now;
        state.waitUntil = now + 1000;
        return reply(503, "Service Unavailable: scheduled maintenance", { "retry-after": "1", "content-type": "text/plain" });
      }
      if (now - state.windowStart >= 1000) {
        state.windowStart = now;
        state.windowCount = 0;
      }
      if (++state.windowCount > LIMIT_PER_SECOND) {
        const seconds = Math.max(1, Math.ceil((state.windowStart + 1000 - now) / 1000));
        state.waitFrom = now;
        state.waitUntil = now + seconds * 1000;
        return reply(429, "Too Many Requests", { "retry-after": String(seconds), "content-type": "text/plain" });
      }

      if (req.method !== "POST" || !body.includes("GetOrder")) return reply(400, fault("Sender", "UnknownOperation", "Only GetOrder is supported"));
      if (!keyOk) return reply(400, fault("Sender", "AuthFailed", "Missing or wrong X-Api-Key header"));
      if (!orderId || !/^A-\d{4}$/.test(orderId)) return reply(400, fault("Sender", "BadOrderId", `Invalid OrderId format: ${orderId ?? "(none)"}`));
      if (state.flaky.delete(orderId)) return reply(500, fault("Receiver", "WarehouseTimeout", "Warehouse system did not respond"));
      const o = ORDERS[orderId];
      if (!o) return reply(400, fault("Sender", "OrderNotFound", `No order with id ${orderId}`));
      return reply(200, envelope(`  <m:GetOrderResponse>
   <m:Order>
    <m:OrderId>${orderId}</m:OrderId>
    <m:StatusCd>${o.status}</m:StatusCd>
    <m:CustNm>${esc(o.customer)}</m:CustNm>
    <m:TotAmtCents>${o.totalCents}</m:TotAmtCents>
    <m:CurrCd>${o.currency}</m:CurrCd>
   </m:Order>
  </m:GetOrderResponse>`));
    },
  });

  const reset = () => {
    Object.assign(state, { mode: "normal", windowStart: 0, windowCount: 0, waitFrom: 0, waitUntil: 0, early: 0 });
    state.flaky.clear();
    state.log = [];
  };
  return { url: `http://127.0.0.1:${server.port}/OrderService`, state, totals, reset, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------------------------------------
// The MCP client: starts your server and talks JSON-RPC to it over stdio.

const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "course-harness", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
type Rpc = { id?: unknown; result?: any; error?: { code: number; message: string; data?: any }; timeout?: true };

function startClient(serverPath: string, env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, serverPath, "serve"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const pending = new Map<number, (m: Rpc) => void>();
  const notJsonRpc: string[] = [];
  let stdout = "";
  let stderr = "";
  let nextId = 1;

  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      const text = dec.decode(chunk, { stream: true });
      stdout += text;
      buf += text;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {}
        if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
          notJsonRpc.push(line);
          continue;
        }
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
  })();
  (async () => {
    for await (const chunk of proc.stderr) stderr += new TextDecoder().decode(chunk);
  })();

  async function request(method: string, params: Record<string, unknown> = {}, meta: object | null = META, timeoutMs = 10_000): Promise<Rpc> {
    const id = nextId++;
    const msg = { jsonrpc: "2.0", id, method, params: meta ? { ...params, _meta: meta } : params };
    const reply = new Promise<Rpc>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve({ timeout: true });
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    proc.stdin.write(JSON.stringify(msg) + "\n");
    proc.stdin.flush();
    return reply;
  }

  async function stop() {
    proc.stdin.end();
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
    if (!exited) proc.kill();
    await Bun.sleep(50);
  }

  return { request, stop, notJsonRpc, out: () => stdout, err: () => stderr };
}

// ---------------------------------------------------------------------------------------------
// The checks.

const text = (r: Rpc) => (r.result?.content ?? []).map((c: any) => c?.text ?? "").join(" ");
const brief = (r: Rpc) =>
  r.timeout ? "no reply within 10 s"
  : r.error ? `JSON-RPC error ${r.error.code}`
  : r.result?.isError ? `isError: "${text(r).slice(0, 70)}"`
  : text(r) ? `result: "${text(r).replace(/\s+/g, " ").slice(0, 70)}"`
  : "a normal result";

export async function runChecks(serverPath: string) {
  const apiKey = "lk_live_" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const legacy = startLegacy(apiKey);
  const client = startClient(serverPath, { LEGACY_URL: legacy.url, LEGACY_API_KEY: apiKey });
  const hide = (s: string) => s.replaceAll(apiKey, "<the API key>");
  const call = (name: string, args: Record<string, unknown>, timeoutMs?: number) =>
    client.request("tools/call", { name, arguments: args }, META, timeoutMs);
  const results: [boolean, string, string][] = [];
  const toolTexts: string[] = [];

  // 2. The version rules: every request carries its protocol version and capabilities in _meta.
  {
    const discover = await client.request("server/discover");
    const noMeta = await client.request("tools/list", {}, null);
    const oldVersion = await client.request("tools/list", {}, { ...META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" });
    const okDiscover = discover.result?.supportedVersions?.includes(PROTOCOL_VERSION) && discover.result?.capabilities?.tools;
    const okNoMeta = noMeta.error?.code === -32602;
    const okOld = oldVersion.error?.code === -32022 && oldVersion.error?.data?.supported?.includes(PROTOCOL_VERSION);
    results.push([!!(okDiscover && okNoMeta && okOld), "Checks the version on every request",
      `discover -> ${okDiscover ? "ok" : brief(discover)}; no _meta -> ${brief(noMeta)} (want -32602); version 1900-01-01 -> ${brief(oldVersion)}${oldVersion.error?.code === -32022 ? ` with supported: ${JSON.stringify(oldVersion.error?.data?.supported ?? null)}` : ""} (want -32022)`]);
  }

  // 3. Translation: the model gets clean fields and words, never the vendor's XML or codes.
  {
    const list = await client.request("tools/list");
    const tool = list.result?.tools?.find((t: any) => t.name === "get_order");
    const r = await call("get_order", { order_id: "A-1001" });
    toolTexts.push(text(r));
    const want = { order_id: "A-1001", status: "shipped", customer: "Brightwater Bikes", total: 1299, currency: "EUR" };
    const ok = !!tool && !r.result?.isError && Bun.deepEquals(r.result?.structuredContent, want) && !text(r).includes("<");
    results.push([ok, "Translates the legacy reply",
      !tool ? "tools/list has no get_order tool"
      : ok ? `get_order A-1001 -> ${JSON.stringify(r.result.structuredContent)}`
      : `get_order A-1001 -> structuredContent ${JSON.stringify(r.result?.structuredContent ?? null)}; text "${text(r).replace(/\s+/g, " ").slice(0, 60)}"\n      want structuredContent ${JSON.stringify(want)} and no XML in the text`]);
  }

  // 4. Two kinds of error: a protocol error for a broken request, isError for a failed tool run.
  {
    const unknownTool = await call("delete_order", { order_id: "A-1001" });
    const missing = await call("get_order", { order_id: "A-9999" });
    const badFormat = await call("get_order", { order_id: "1001" });
    toolTexts.push(text(missing), text(badFormat));
    const ok1 = unknownTool.error?.code === -32602;
    const ok2 = missing.result?.isError === true && text(missing).includes("A-9999") && !text(missing).includes("<");
    const ok3 = badFormat.result?.isError === true && text(badFormat).includes("A-") && !text(badFormat).includes("<");
    results.push([ok1 && ok2 && ok3, "Two kinds of error",
      `unknown tool -> ${brief(unknownTool)} (want -32602)\n      order A-9999 -> ${brief(missing)} (want isError naming A-9999, no XML)\n      order "1001" -> ${brief(badFormat)} (want isError showing what an id looks like)`]);
  }

  // 5. Waiting when told to: a burst over the rate limit, then a one-off Receiver fault.
  {
    legacy.reset();
    const ids = ["A-1001", "A-1002", "A-1003", "A-1004", "A-1005"];
    const burst = await Promise.all(ids.map((id) => call("get_order", { order_id: id })));
    burst.forEach((r) => toolTexts.push(text(r)));
    const served = ids.filter((id) => legacy.state.log.some((l) => l.orderId === id && l.status === 200));
    const told = legacy.state.log.filter((l) => l.status === 429).length;
    const answered = burst.filter((r) => r.result && !r.result.isError).length;
    const earlyBurst = legacy.state.early;

    legacy.reset();
    legacy.state.flaky.add("A-1004");
    const flaky = await call("get_order", { order_id: "A-1004" });
    toolTexts.push(text(flaky));
    const flakyTries = legacy.state.log.filter((l) => l.orderId === "A-1004").length;
    const flakyOk = !!flaky.result && !flaky.result.isError && legacy.state.log.some((l) => l.orderId === "A-1004" && l.status === 200);

    const ok = served.length === 5 && answered === 5 && earlyBurst === 0 && flakyOk;
    results.push([ok, "Waits when the legacy system says later",
      `5 calls at once -> ${served.length} served by the legacy system, ${told} told to wait, ${earlyBurst} retried too early (want 5 served, 0 early)\n      A-1004 with one Receiver fault -> ${flakyOk ? `answered after ${flakyTries} tries` : brief(flaky)} (want answered)`]);
  }

  // 6. Giving up: when the system is down, stop after 3 attempts and say so.
  {
    legacy.reset();
    legacy.state.mode = "down";
    const r = await call("get_order", { order_id: "A-1002" }, 15_000);
    toolTexts.push(text(r));
    const tries = legacy.state.log.length;
    const ok = r.result?.isError === true && tries >= 1 && tries <= 3 && legacy.state.early === 0 && !text(r).includes("<");
    results.push([ok, "Gives up after 3 tries",
      `legacy system down -> ${brief(r)} after ${tries} ${tries === 1 ? "try" : "tries"}, ${legacy.state.early} too early (want isError within 3 tries, 0 early)`]);
    legacy.state.mode = "normal";
  }

  await client.stop();
  legacy.stop();
  const stdout = client.out();
  const stderr = client.err();

  // 1. stdout is the protocol channel: every line must be a JSON-RPC message.
  {
    const bad = client.notJsonRpc.filter((l) => l.trim() !== "");
    results.unshift([stdout.length > 0 && bad.length === 0, "stdout carries only JSON-RPC",
      stdout.length === 0 ? `the server wrote nothing to stdout${stderr ? `; stderr says: ${hide(stderr.trim().split("\n").slice(-3).join(" | ")).slice(0, 200)}` : ""}`
      : bad.length ? `${bad.length} line(s) on stdout are not JSON-RPC, e.g. ${JSON.stringify(hide(bad[0]).slice(0, 80))}`
      : "every line on stdout parsed as a JSON-RPC message"]);
  }

  // 7. The API key: read from the environment, sent to the legacy system, shown to nobody else.
  {
    const keyOk = legacy.totals.requests > 0 && legacy.totals.keyOk === legacy.totals.requests;
    const where = [
      stdout.includes(apiKey) && "stdout",
      stderr.includes(apiKey) && "stderr (logs)",
      toolTexts.some((t) => t.includes(apiKey)) && "tool results",
    ].filter(Boolean);
    results.push([where.length === 0 && keyOk, "The API key stays secret",
      !keyOk ? `${legacy.totals.requests - legacy.totals.keyOk} of ${legacy.totals.requests} calls to the legacy system lacked the right X-Api-Key header`
      : where.length ? `the key appeared in: ${where.join(", ")}`
      : "the key reached the legacy system and appeared nowhere else"]);
  }

  for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  const passed = results.filter(([ok]) => ok).length;
  console.log(`\n${passed}/${results.length} checks pass.`);
}
