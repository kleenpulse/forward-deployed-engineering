// Shared setup and checks for the Lesson 7 exercise. You don't need to edit this file.
//
// Acme's support agent can now start returns. A return is money going back to a customer, so
// Acme's rule is: returns of EUR 500 or more need a yes from a returns manager first.
//
// This file plays everything around your workflow:
//   - the legacy order system from Lesson 5. CreateReturn changes data and has NO idempotency
//     key. It does store a free-text ExternalRef on each return, and FindReturn looks one up.
//   - a notifier that messages the customer. It accepts a dedupe key: a second message with
//     the same key is dropped.
//   - the approval app (think: a button in Slack). When a manager clicks, it writes a row to
//     approval_decisions and then calls your run() again, the way a signal wakes a workflow.
//   - a clock you don't control. Use now() from here, never new Date(), so the checks can
//     move time forward.
//   - crashes. Sometimes the process dies right after CreateReturn succeeded, before your
//     code gets the answer. The checks then "restart the worker": they call run() again.
import { PGlite } from "@electric-sql/pglite";

export const db = new PGlite();

export const APPROVAL_LIMIT = 500; // EUR. At or above this, a returns manager must approve.
export const APPROVERS = ["maria"]; // Acme's returns managers. Nobody else's click counts.
export const APPROVAL_TIMEOUT_HOURS = 48; // After this with no decision, the request expires.

export type ReturnInput = { order_id: string; amount: number; reason: string; requested_by: string };
export type Status = "running" | "waiting_for_approval" | "done" | "rejected" | "expired";
export type Workflow = {
  setup: () => Promise<void>; // create your tables, once
  start: (input: ReturnInput) => Promise<string>; // record a new workflow, return its id
  run: (id: string) => Promise<Status>; // move it forward as far as it can go right now
};

// The approval app's tables. Your workflow writes requests and reads decisions.
await db.exec(`
  create table approval_requests (
    workflow_id  text primary key,
    order_id     text not null,
    amount       numeric(12,2) not null,
    summary      text not null,        -- what the manager reads before clicking
    requested_at timestamptz not null
  );
  create table approval_decisions (
    id          serial primary key,
    workflow_id text not null,
    decided_by  text not null,
    decision    text not null check (decision in ('approve', 'reject')),
    decided_at  timestamptz not null
  );
`);

// ---------------------------------------------------------------------------------------------
// The clock.
let clock = Date.parse("2026-11-02T09:00:00Z");
export const now = () => new Date(clock);
const advance = (hours: number) => { clock += hours * 3_600_000; };

/** Thrown to simulate the process dying. Don't catch it: a real crash can't be caught. */
export class Crash extends Error {}

// ---------------------------------------------------------------------------------------------
// The legacy order system (a stand-in for the SOAP service from Lesson 5).

type Return = { return_id: string; order_id: string; amount: number; external_ref: string };
const ORDERS: Record<string, { customer: string; total: number; currency: string }> = {
  "A-1001": { customer: "Brightwater Bikes", total: 1299, currency: "EUR" },
  "A-1002": { customer: "Halden Dental Supply", total: 482.5, currency: "EUR" },
  "A-1004": { customer: "Larchmont Print Co.", total: 3150, currency: "EUR" },
  "A-1006": { customer: "Müller Werkzeuge GmbH", total: 845.1, currency: "EUR" },
  "A-1008": { customer: "Søndergaard Design", total: 2400, currency: "EUR" },
};
const legacy = {
  returns: [] as Return[],
  reads: 0,
  crashAfterCreate: new Set<string>(), // order ids whose next CreateReturn "kills the worker"
};
const sent: { key: string; to: string; text: string }[] = [];

/** Small random pauses, so two calls running at once really interleave. */
const io = () => Bun.sleep(5 + Math.random() * 10);

export const orders = {
  async getOrder(order_id: string) {
    await io();
    legacy.reads++;
    const o = ORDERS[order_id];
    if (!o) throw new Error(`There is no order ${order_id}.`);
    return { order_id, ...o };
  },
  /** Changes data. No idempotency key: two calls make two returns. */
  async createReturn(args: { order_id: string; amount: number; external_ref: string }) {
    await io();
    const r = { return_id: `R-${7001 + legacy.returns.length}`, ...args };
    legacy.returns.push(r);
    if (legacy.crashAfterCreate.delete(args.order_id)) throw new Crash("the worker died right after CreateReturn succeeded");
    return { return_id: r.return_id };
  },
  /** Only reads. Finds the return created with this ExternalRef, if any. */
  async findReturn(external_ref: string) {
    await io();
    const r = legacy.returns.find((x) => x.external_ref === external_ref);
    return r ? { return_id: r.return_id } : null;
  },
};

export const notifier = {
  /** Messages the customer. A second call with the same dedupe key is dropped. */
  async send(to: string, text: string, dedupeKey?: string) {
    await io();
    if (dedupeKey && sent.some((m) => m.key === dedupeKey)) { return; }
    sent.push({ key: dedupeKey ?? crypto.randomUUID(), to, text });
  },
};

// ---------------------------------------------------------------------------------------------
// The checks.

async function click(workflow_id: string, decided_by: string, decision: "approve" | "reject") {
  await db.query("insert into approval_decisions (workflow_id, decided_by, decision, decided_at) values ($1, $2, $3, $4)",
    [workflow_id, decided_by, decision, now().toISOString()]);
}
const returnsFor = (order_id: string) => legacy.returns.filter((r) => r.order_id === order_id).length;
const messagesTo = (order_id: string) => sent.filter((m) => m.to === ORDERS[order_id].customer).length;
const request = async (id: string) =>
  (await db.query<{ amount: string; summary: string }>("select amount::text, summary from approval_requests where workflow_id = $1", [id])).rows[0];
const input = (order_id: string, amount: number): ReturnInput =>
  ({ order_id, amount, reason: "Arrived damaged", requested_by: "support-agent" });

export async function runChecks(wf: Workflow) {
  const results: [boolean, string, string][] = [];
  const check = async (name: string, fn: () => Promise<[boolean, string]>) => {
    try {
      const [ok, detail] = await fn();
      results.push([ok, name, detail]);
    } catch (e) {
      results.push([false, name, `${e instanceof Crash ? "the worker crashed and nothing recovered it" : "crashed"}: ${(e as Error).message}`]);
    }
  };
  /** Runs, and if the worker "dies", restarts it a minute later, up to 3 times. */
  const runWithRestarts = async (id: string) => {
    for (let i = 0; ; i++) {
      try {
        return await wf.run(id);
      } catch (e) {
        if (!(e instanceof Crash) || i >= 3) throw e;
        advance(1 / 60);
      }
    }
  };

  await wf.setup();

  // 1. Big returns stop at the gate and ask a person; small ones don't.
  await check("Stops at the gate", async () => {
    const big = await wf.start(input("A-1001", 1299));
    const s1 = await wf.run(big);
    const req = await request(big);
    const small = await wf.start(input("A-1002", 49));
    const s2 = await wf.run(small);
    const smallReq = await request(small);
    const ok = s1 === "waiting_for_approval" && returnsFor("A-1001") === 0 && !!req && Number(req.amount) === 1299 &&
      /A-1001/.test(req.summary) && s2 === "done" && returnsFor("A-1002") === 1 && !smallReq;
    return [ok, `EUR 1299 -> ${s1}, ${returnsFor("A-1001")} return(s) created, request ${req ? `"${req.summary}"` : "none"} ` +
      `(want waiting_for_approval, 0, a request naming A-1001 and the amount); EUR 49 -> ${s2}, ${returnsFor("A-1002")} return(s), ` +
      `${smallReq ? "asked for approval" : "no approval asked"} (want done, 1, no approval)`];
  });

  // 2. A no means no.
  await check("A no means no", async () => {
    const id = await wf.start(input("A-1006", 845.1));
    await wf.run(id);
    advance(2);
    await click(id, "maria", "reject");
    const s = await wf.run(id);
    return [s === "rejected" && returnsFor("A-1006") === 0,
      `maria rejects -> ${s}, ${returnsFor("A-1006")} return(s) created (want rejected, 0)`];
  });

  // 3. Only a real approver's click counts. The agent can't approve its own request.
  let approvedId = "";
  await check("Only a real approver counts", async () => {
    const id = await wf.start(input("A-1004", 3150));
    approvedId = id;
    await wf.run(id);
    advance(1);
    await click(id, "support-agent", "approve");
    const sAgent = await wf.run(id);
    await click(id, "dana", "approve");
    const sDana = await wf.run(id);
    const before = returnsFor("A-1004");
    return [sAgent === "waiting_for_approval" && sDana === "waiting_for_approval" && before === 0,
      `support-agent approves -> ${sAgent}; dana (not a returns manager) approves -> ${sDana}; ${before} return(s) so far ` +
      `(want waiting_for_approval twice, 0)`];
  });

  // 4. After a real yes, it resumes from its checkpoint: no step runs twice.
  await check("Resumes where it stopped", async () => {
    const readsBefore = legacy.reads;
    const msgs = messagesTo("A-1004");
    advance(3);
    await click(approvedId, "maria", "approve");
    const s = await wf.run(approvedId);
    const again = await wf.run(approvedId);
    const reads = legacy.reads - readsBefore;
    return [s === "done" && again === "done" && returnsFor("A-1004") === 1 && messagesTo("A-1004") - msgs === 1 && reads === 0,
      `maria approves -> ${s}, then run() again -> ${again}; ${returnsFor("A-1004")} return(s), ${messagesTo("A-1004") - msgs} message(s), ` +
      `order looked up again ${reads} time(s) (want done, done, 1, 1, 0: the lookup was saved before the pause)`];
  });

  // 5. The worker dies right after CreateReturn succeeded. The restart must not make a second return.
  await check("A crash doesn't double the return", async () => {
    const id = await wf.start(input("A-1008", 2400));
    await wf.run(id);
    await click(id, "maria", "approve");
    legacy.crashAfterCreate.add("A-1008");
    const msgs = messagesTo("A-1008");
    const s = await runWithRestarts(id);
    return [s === "done" && returnsFor("A-1008") === 1 && messagesTo("A-1008") - msgs === 1,
      `crash after CreateReturn, restart -> ${s}; ${returnsFor("A-1008")} return(s), ${messagesTo("A-1008") - msgs} message(s) (want done, 1, 1)`];
  });

  // 6. Maria double-clicks Approve: two run() calls at the same moment.
  await check("A double click doesn't either", async () => {
    const id = await wf.start(input("A-1001", 1299));
    await wf.run(id);
    await click(id, "maria", "approve");
    const before = returnsFor("A-1001");
    const msgs = messagesTo("A-1001");
    const both = await Promise.all([wf.run(id), wf.run(id)]);
    const after = returnsFor("A-1001") - before;
    const final = await wf.run(id);
    return [after === 1 && final === "done" && messagesTo("A-1001") - msgs === 1,
      `two runs at once -> ${both.join(" and ")}; ${after} return(s) created, ${messagesTo("A-1001") - msgs} message(s), then ${final} ` +
      `(want 1 return, 1 message, then done)`];
  });

  // 7. Nobody answers. Two days later the request expires instead of waiting forever.
  await check("Nobody waits forever", async () => {
    const msgsBefore = messagesTo("A-1006");
    const id = await wf.start(input("A-1006", 600));
    const s1 = await wf.run(id);
    advance(APPROVAL_TIMEOUT_HOURS - 1);
    const s2 = await wf.run(id);
    advance(2);
    const s3 = await wf.run(id);
    await click(id, "maria", "approve"); // too late
    const s4 = await wf.run(id);
    return [s1 === "waiting_for_approval" && s2 === "waiting_for_approval" && s3 === "expired" && s4 === "expired" &&
      returnsFor("A-1006") === 0 && messagesTo("A-1006") - msgsBefore === 1,
      `at 0 h ${s1}, at 47 h ${s2}, at 49 h ${s3}, late approval -> ${s4}; ${returnsFor("A-1006")} return(s), ` +
      `${messagesTo("A-1006") - msgsBefore} message(s) to the customer (want waiting, waiting, expired, expired, 0, 1 saying it wasn't done)`];
  });

  for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  const passed = results.filter((r) => r[0]).length;
  console.log(`\n${passed}/${results.length} checks pass.`);
  await db.close(); // without this, PGlite can keep the process alive for several seconds
}
