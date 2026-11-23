// Shared setup and checks for the Lesson 9 exercise. You don't need to edit this file.
//
// Acme's support agent has been live for four weeks (Monday 26 October to Friday 20 November
// 2026). Dana, the COO, wants four answers before the renewal meeting:
//   1. What does it cost, per team?
//   2. Did order-status emails get answered faster? The baseline from Lesson 2: a median of
//      22 hours to the first response, measured in the helpdesk before the agent went live.
//   3. Do people actually use it?
//   4. Is it working right now? (An alert you'd have wanted during the pilot.)
//
// Two tables, already loaded into Postgres (PGlite):
//
//   spans: OpenTelemetry spans from the agent, one row per span. Every agent run is one trace:
//     a root span "invoke_agent support-agent" with child spans under it:
//       "chat <model>"            one call to a model. Carries the token counts.
//       "execute_tool get_order"  one tool call. status 'error' if the call failed.
//     columns: trace_id, span_id, parent_id (null on the root), name, start_time, end_time,
//              status ('ok' or 'error'), attrs (jsonb, the span's attributes).
//     Attributes follow the OpenTelemetry GenAI semantic conventions, plus Acme's own "app.*":
//       gen_ai.operation.name                 'invoke_agent', 'chat' or 'execute_tool'
//       gen_ai.request.model                  on chat spans: 'large-model' or 'small-model'
//       gen_ai.usage.input_tokens             input tokens, INCLUDING the ones read from cache
//       gen_ai.usage.cache_read.input_tokens  the part of input_tokens served from the cache
//       gen_ai.usage.output_tokens            output tokens
//       app.team      on root spans: 'support', 'returns' or 'finance'
//       app.source    on root spans: 'live', or 'eval' for your own Lesson 8 eval runs
//       app.result    on root spans: 'answered', or 'handed_off' when the agent gave the email
//                     to a person because it couldn't answer
//       helpdesk.ticket_id  on root spans of runs that drafted a reply to a ticket
//     Careful: the agent framework ALSO copies the run's total token counts onto the root span.
//
//   tickets: the helpdesk. One row per customer email.
//     columns: ticket_id, category ('order_status' or 'other'), created_at,
//              first_response_at (null if nobody has answered yet),
//              draft ('used': sent the agent's draft, 'discarded': wrote their own,
//                     'none': the agent handed it off, or never ran).
import { PGlite } from "@electric-sql/pglite";

export const db = new PGlite();

/** USD per million tokens (MTok). Example prices; take real ones from your provider's pricing
 *  page. cacheRead is a multiplier on the input price for tokens read from the cache. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "large-model": { input: 3.0, output: 15.0, cacheRead: 0.1 },
  "small-model": { input: 0.8, output: 4.0, cacheRead: 0.1 },
};
export const BASELINE_HOURS = 22; // median first response for order-status emails, before the pilot
export const REPORT_TIME = "2026-11-21T00:00:00Z"; // when Dana reads the report

export type TeamCost = { team: string; runs: number; input_tokens: number; output_tokens: number; cost_usd: number };
export type WeekShare = { week: string; share: number }; // week: the Monday, 'YYYY-MM-DD'
export type Telemetry = {
  costByTeam: () => Promise<TeamCost[]>; // live runs only, one row per team, sorted by team
  medianFirstResponseHours: () => Promise<number>; // order-status emails created during the pilot
  adoptionByWeek: () => Promise<WeekShare[]>; // per week: share of order-status emails sent with the agent's draft
  alerts: () => Promise<string[]>; // the days (UTC, 'YYYY-MM-DD') your alert would have fired, sorted
};

// ---------------------------------------------------------------------------------------------
// The pilot, generated from a fixed seed so every run of this file sees the same month.

let seed = 20261126;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a: number, b: number) => a + rand() * (b - a);
const H = 3_600_000;

type Span = { trace_id: string; span_id: string; parent_id: string | null; name: string; start_time: string; end_time: string; status: string; attrs: Record<string, unknown> };
type Ticket = { ticket_id: string; category: string; created_at: string; first_response_at: string | null; draft: string };
type RunTruth = { day: string; team: string; source: string; handedOff: boolean; chats: { model: string; input: number; cache: number; output: number }[] };

const spans: Span[] = [];
const tickets: Ticket[] = [];
const truthRuns: RunTruth[] = [];
const report = Date.parse(REPORT_TIME);
const iso = (ms: number) => new Date(ms).toISOString();
let traces = 0, ticketNo = 48000;

const OUTAGE_DAY = "2026-11-03"; // the order system is down for maintenance, 10:00 to 14:00
const SILENT_FROM = "2026-11-17"; // the order system's new release sends a status code nobody mapped
const QUIET_SUNDAY = "2026-11-08";
const ADOPTION = [0.62, 0.71, 0.76, 0.78]; // how often support staff send an answered draft, by week

function run(startMs: number, day: string, team: string, source: string, ticket?: string): boolean {
  const trace_id = `t${String(++traces).padStart(5, "0")}`;
  const root = `${trace_id}-0`;
  let t = startMs, n = 0;
  const child = (name: string, ms: number, status: string, attrs: Record<string, unknown>) => {
    spans.push({ trace_id, span_id: `${trace_id}-${++n}`, parent_id: root, name, start_time: iso(t), end_time: iso(t + ms), status, attrs });
    t += ms;
  };
  const chats: RunTruth["chats"] = [];
  const chat = (model: string, input: number, cache: number, output: number) => {
    chats.push({ model, input, cache, output });
    child(`chat ${model}`, between(400, 2500), "ok", {
      "gen_ai.operation.name": "chat", "gen_ai.request.model": model,
      "gen_ai.usage.input_tokens": input, "gen_ai.usage.cache_read.input_tokens": cache, "gen_ai.usage.output_tokens": output,
    });
  };
  const tool = (status: string, orderStatus?: string) => child("execute_tool get_order", between(150, 900), status, {
    "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "get_order",
    ...(status === "error" ? { "error.type": "SoapFault" } : { "acme.order.status": orderStatus }),
  });

  const hour = new Date(startMs).getUTCHours();
  const live = source === "live";
  let handedOff: boolean;
  chat("small-model", Math.round(between(700, 1100)), 512, Math.round(between(8, 30)));
  if (live && day === OUTAGE_DAY && hour >= 10 && hour < 14) {
    tool("error"); tool("error"); tool("error"); // three tries, all failed: a person takes over
    handedOff = true;
  } else {
    if (live && (rand() < 0.05 || (day === QUIET_SUNDAY && traces % 4 === 0))) tool("error"); // failed once, the retry worked
    const silent = live && day >= SILENT_FROM && rand() < 0.4;
    tool("ok", silent ? "unknown" : "shipped");
    handedOff = silent || (live ? rand() < 0.08 : rand() < 0.04);
  }
  chat("large-model", Math.round(between(2800, 3600)), 2400, Math.round(between(110, 260)));

  const sum = (k: "input" | "cache" | "output") => chats.reduce((s, c) => s + c[k], 0);
  spans.push({ trace_id, span_id: root, parent_id: null, name: "invoke_agent support-agent", start_time: iso(startMs), end_time: iso(t), status: "ok", attrs: {
    "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "support-agent",
    "app.team": team, "app.source": source, "app.result": handedOff ? "handed_off" : "answered",
    ...(ticket ? { "helpdesk.ticket_id": ticket } : {}),
    // The framework's roll-up of every chat span below. Real ones do this too.
    "gen_ai.usage.input_tokens": sum("input"), "gen_ai.usage.cache_read.input_tokens": sum("cache"), "gen_ai.usage.output_tokens": sum("output"),
  } });
  truthRuns.push({ day, team, source, handedOff, chats });
  return handedOff;
}

for (let d = Date.parse("2026-10-26T00:00:00Z"); d < Date.parse("2026-11-21T00:00:00Z"); d += 24 * H) {
  const day = iso(d).slice(0, 10);
  const dow = new Date(d).getUTCDay(); // 0 Sunday, 6 Saturday
  const week = Math.floor((d - Date.parse("2026-10-26T00:00:00Z")) / (7 * 24 * H));
  const orderStatus = dow === 0 ? 4 : dow === 6 ? 6 : 40;
  for (let i = 0; i < orderStatus; i++) {
    const created = d + between(7, 18) * H;
    const id = `HD-${++ticketNo}`;
    const handedOff = run(created + 60_000, day, "support", "live", id);
    const draft = handedOff ? "none" : rand() < ADOPTION[week] ? "used" : "discarded";
    const wait = draft === "used" ? between(0.2, 3) : draft === "discarded" ? between(3, 20) : between(6, 70);
    const responded = created + wait * H;
    tickets.push({ ticket_id: id, category: "order_status", created_at: iso(created), first_response_at: responded < report ? iso(responded) : null, draft });
  }
  if (dow !== 0 && dow !== 6) {
    for (let i = 0; i < 10; i++) {
      const created = d + between(7, 18) * H, responded = created + between(4, 60) * H;
      tickets.push({ ticket_id: `HD-${++ticketNo}`, category: "other", created_at: iso(created), first_response_at: responded < report ? iso(responded) : null, draft: "none" });
    }
    for (let i = 0; i < 8; i++) run(d + between(8, 17) * H, day, "returns", "live");
    for (let i = 0; i < 3; i++) run(d + between(8, 17) * H, day, "finance", "live");
  }
  if (day === "2026-11-16" || day === "2026-11-19") // your Lesson 8 eval: 48 runs, one evening
    for (let i = 0; i < 48; i++) run(d + 20 * H + i * 30_000, day, "support", "eval");
}

await db.exec(`
  create table spans (
    trace_id text not null, span_id text primary key, parent_id text,
    name text not null, start_time timestamptz not null, end_time timestamptz not null,
    status text not null, attrs jsonb not null
  );
  create table tickets (
    ticket_id text primary key, category text not null, created_at timestamptz not null,
    first_response_at timestamptz, draft text not null
  );
`);
await db.query(`insert into spans select * from jsonb_to_recordset($1::jsonb) as x(
  trace_id text, span_id text, parent_id text, name text, start_time timestamptz, end_time timestamptz, status text, attrs jsonb)`,
  [JSON.stringify(spans)]);
await db.query(`insert into tickets select * from jsonb_to_recordset($1::jsonb) as x(
  ticket_id text, category text, created_at timestamptz, first_response_at timestamptz, draft text)`,
  [JSON.stringify(tickets)]);

// ---------------------------------------------------------------------------------------------
// What the right answers are, worked out from the generator, not from SQL.

const live = truthRuns.filter((r) => r.source === "live");
const truthCost: TeamCost[] = ["finance", "returns", "support"].map((team) => {
  const rs = live.filter((r) => r.team === team);
  const cs = rs.flatMap((r) => r.chats);
  const cost = cs.reduce((s, c) => {
    const p = PRICES[c.model];
    return s + ((c.input - c.cache) * p.input + c.cache * p.input * p.cacheRead + c.output * p.output) / 1e6;
  }, 0);
  return { team, runs: rs.length, input_tokens: cs.reduce((s, c) => s + c.input, 0), output_tokens: cs.reduce((s, c) => s + c.output, 0), cost_usd: cost };
});
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length / 2;
  return s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2;
};
const os = tickets.filter((t) => t.category === "order_status");
const truthMedian = median(os.map((t) => ((t.first_response_at ? Date.parse(t.first_response_at) : report) - Date.parse(t.created_at)) / H));
const mondayOf = (ts: string) => {
  const d = new Date(ts.slice(0, 10) + "T00:00:00Z");
  return iso(d.getTime() - ((d.getUTCDay() + 6) % 7) * 24 * H).slice(0, 10);
};
const truthAdoption: WeekShare[] = [...new Set(os.map((t) => mondayOf(t.created_at)))].sort().map((week) => {
  const w = os.filter((t) => mondayOf(t.created_at) === week);
  return { week, share: w.filter((t) => t.draft === "used").length / w.length };
});
const days = [...new Set(live.map((r) => r.day))].sort();
const perDay = days.map((day) => {
  const rs = live.filter((r) => r.day === day);
  return { day, runs: rs.length, share: rs.filter((r) => r.handedOff).length / rs.length };
});
const truthAlerts = perDay.filter((d) => d.runs >= 20 && d.share > 0.2).map((d) => d.day);

// ---------------------------------------------------------------------------------------------
// The checks.

export async function runChecks(t: Telemetry) {
  const results: [boolean, string, string][] = [];
  const check = async (name: string, fn: () => Promise<[boolean, string]>) => {
    try {
      const [ok, detail] = await fn();
      results.push([ok, name, detail]);
    } catch (e) {
      results.push([false, name, `crashed: ${(e as Error).message}`]);
    }
  };
  const num = (x: unknown) => Number(x);
  let cost: TeamCost[] = [];
  try { cost = await t.costByTeam(); } catch (e) { cost = []; console.log(`costByTeam crashed: ${(e as Error).message}`); }
  const tokens = (rows: { input_tokens: unknown; output_tokens: unknown }[]) =>
    [rows.reduce((s, r) => s + num(r.input_tokens), 0), rows.reduce((s, r) => s + num(r.output_tokens), 0)];
  const liveSupport = truthCost.find((r) => r.team === "support")!;

  // 1. Each token counted once.
  await check("Counts each token once", async () => {
    const [gi, go] = tokens(cost), [wi, wo] = tokens(truthCost);
    return [gi === wi && go === wo,
      `${gi.toLocaleString("en")} input and ${go.toLocaleString("en")} output tokens (want ${wi.toLocaleString("en")} and ${wo.toLocaleString("en")})`];
  });

  // 2. Prices are per million tokens, per model, and cached input costs less.
  await check("Prices tokens per MTok, per model, cache included", async () => {
    const got = cost.reduce((s, r) => s + num(r.cost_usd), 0), want = truthCost.reduce((s, r) => s + r.cost_usd, 0);
    return [Math.abs(got - want) < 0.01, `total USD ${got.toFixed(2)} (want ${want.toFixed(2)})`];
  });

  // 3. Cost lands on the team whose run it was, and your own eval runs aren't Acme's usage.
  await check("Puts the cost on the right team, without eval traffic", async () => {
    const show = (rows: { team: unknown; runs: unknown }[]) => rows.map((r) => `${r.team ?? "null"} ${num(r.runs)}`).join(", ");
    const ok = cost.length === 3 && truthCost.every((w, i) => cost[i]?.team === w.team && num(cost[i].runs) === w.runs &&
      Math.abs(num(cost[i].cost_usd) - w.cost_usd) < 0.01);
    return [ok, `runs per team: ${show(cost)} (want ${show(truthCost)}); support costs USD ${num(cost.find((r) => r.team === "support")?.cost_usd ?? NaN).toFixed(2)} ` +
      `(want ${liveSupport.cost_usd.toFixed(2)})`];
  });

  // 4. The success metric, measured the way it was agreed.
  await check("Reports the median, honestly", async () => {
    const got = num(await t.medianFirstResponseHours());
    return [Math.abs(got - truthMedian) < 0.01,
      `median first response ${got.toFixed(2)} h (want ${truthMedian.toFixed(2)} h; the baseline was ${BASELINE_HOURS} h)`];
  });

  // 5. Adoption: is the draft actually sent?
  await check("Measures adoption, not activity", async () => {
    const got = await t.adoptionByWeek();
    const fmt = (ws: WeekShare[]) => ws.map((w) => `${String(w.week).slice(5)} ${(num(w.share) * 100).toFixed(1)}%`).join(", ");
    const ok = got.length === truthAdoption.length &&
      truthAdoption.every((w, i) => String(got[i].week).slice(0, 10) === w.week && Math.abs(num(got[i].share) - w.share) < 0.001);
    return [ok, `${fmt(got)} (want ${fmt(truthAdoption)})`];
  });

  // 6 and 7. The alert.
  let fired: string[] = [];
  try { fired = (await t.alerts()).map((d) => String(d).slice(0, 10)); } catch (e) { console.log(`alerts crashed: ${(e as Error).message}`); }
  const missed = truthAlerts.filter((d) => !fired.includes(d));
  const extra = fired.filter((d) => !truthAlerts.includes(d));
  await check("Alerts on what customers feel, even with no errors", async () =>
    [missed.length === 0, `fired on [${fired.join(", ")}]; missed [${missed.join(", ")}] (want it to fire on ${truthAlerts.join(", ")})`]);
  await check("Stays quiet when nothing is wrong", async () => {
    const q = perDay.find((d) => d.day === QUIET_SUNDAY)!;
    return [extra.length === 0 && fired.length > 0,
      `false alarms on [${extra.join(", ")}] (want none; Sundays have about ${q.runs} runs, and a tool error that a retry fixed is one no customer noticed)`];
  });

  for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  const passed = results.filter((r) => r[0]).length;
  console.log(`\n${passed}/${results.length} checks pass.`);

  // What Dana would read, from your functions.
  try {
    const total = cost.reduce((s, r) => s + num(r.cost_usd), 0), runs = cost.reduce((s, r) => s + num(r.runs), 0);
    console.log(`\nWhat your numbers tell Dana:`);
    console.log(`  Cost: USD ${total.toFixed(2)} for ${runs} runs. ` + cost.map((r) => `${r.team ?? "no team"} ${num(r.cost_usd).toFixed(2)}`).join(", ") + ".");
    console.log(`  First response for order-status emails: ${num(await t.medianFirstResponseHours()).toFixed(1)} h (baseline ${BASELINE_HOURS} h).`);
    console.log(`  Adoption by week: ${(await t.adoptionByWeek()).map((w) => `${String(w.week).slice(5, 10)} ${(num(w.share) * 100).toFixed(0)}%`).join(", ")}.`);
    console.log(`  Alert would have fired on: ${fired.join(", ") || "no day"}.`);
  } catch (e) {
    console.log(`  (couldn't build the summary: ${(e as Error).message})`);
  }
  await db.close(); // without this, PGlite can keep the process alive for several seconds
}
