// Lesson 7 exercise: worked solution.
// Run: bun exercises/0007-approvals/solution.ts
//
// The shape: run() is a function you can call any number of times. Each call claims the
// workflow, replays saved steps from the database, does the next step that hasn't run,
// and stops at the approval gate. Side effects look before they act.
import {
  APPROVAL_LIMIT, APPROVAL_TIMEOUT_HOURS, APPROVERS, db, notifier, now, orders, runChecks,
  type ReturnInput, type Status,
} from "./harness.ts";

const LEASE_SECONDS = 30;

async function setup() {
  await db.exec(`
    create table workflows (
      id          text primary key,
      input       jsonb not null,
      status      text not null,
      lease_until timestamptz           -- who is running it right now, and until when
    );
    -- One row per finished step. The primary key makes "this step ran" a fact, not a hope.
    create table steps (
      workflow_id text not null references workflows (id),
      step        text not null,
      result      jsonb,
      done_at     timestamptz not null,
      primary key (workflow_id, step)
    );
  `);
}

async function start(input: ReturnInput): Promise<string> {
  const id = `wf-${crypto.randomUUID().slice(0, 8)}`;
  await db.query("insert into workflows (id, input, status) values ($1, $2, 'running')", [id, input]);
  return id;
}

/** Runs fn once per (workflow, step). Later calls get the saved result instead. */
async function step<T>(id: string, name: string, fn: () => Promise<T>): Promise<T> {
  const saved = await db.query<{ result: T }>("select result from steps where workflow_id = $1 and step = $2", [id, name]);
  if (saved.rows.length) return saved.rows[0].result;
  const result = await fn();
  // If the process dies between fn() and this insert, the step runs again on restart.
  // That is why every fn() with a side effect must be safe to run twice.
  await db.query("insert into steps (workflow_id, step, result, done_at) values ($1, $2, $3, $4)",
    [id, name, JSON.stringify(result ?? null), now().toISOString()]);
  return result;
}

async function finish(id: string, status: Status): Promise<Status> {
  await db.query("update workflows set status = $2, lease_until = null where id = $1", [id, status]);
  return status;
}

async function run(id: string): Promise<Status> {
  // Claim the workflow. Only one caller gets the row back; a double click gets nothing.
  const t = now();
  const claim = await db.query(
    `update workflows set lease_until = $2, status = 'running'
      where id = $1 and status not in ('done', 'rejected', 'expired')
        and (lease_until is null or lease_until < $3)
      returning id`,
    [id, new Date(t.getTime() + LEASE_SECONDS * 1000).toISOString(), t.toISOString()]);
  if (!claim.rows.length) {
    const { status } = (await db.query<{ status: Status }>("select status from workflows where id = $1", [id])).rows[0];
    return status; // finished, or "running" in another caller right now
  }

  const { input } = (await db.query<{ input: ReturnInput }>("select input from workflows where id = $1", [id])).rows[0];
  const order = await step(id, "look_up_order", () => orders.getOrder(input.order_id));

  if (input.amount >= APPROVAL_LIMIT) {
    await step(id, "request_approval", async () => {
      await db.query(
        "insert into approval_requests (workflow_id, order_id, amount, summary, requested_at) values ($1, $2, $3, $4, $5)",
        [id, order.order_id, input.amount,
         `Return EUR ${input.amount.toFixed(2)} on order ${order.order_id} (${order.customer}, order total ` +
         `${order.currency} ${order.total.toFixed(2)}). Reason: ${input.reason}. Requested by ${input.requested_by}.`,
         now().toISOString()]);
      return { requested_at: now().toISOString() };
    });
    const { requested_at } = (await db.query<{ requested_at: Date }>(
      "select requested_at from approval_requests where workflow_id = $1", [id])).rows[0];
    const deadline = new Date(requested_at.getTime() + APPROVAL_TIMEOUT_HOURS * 3_600_000);

    // The first decision by a real approver, made before the deadline, wins. Everything else is noise.
    const decision = (await db.query<{ decision: "approve" | "reject"; decided_by: string }>(
      `select decision, decided_by from approval_decisions
        where workflow_id = $1 and decided_by = any($2) and decided_at <= $3
        order by decided_at, id limit 1`,
      [id, APPROVERS, deadline.toISOString()])).rows[0];

    if (!decision) {
      if (now() > deadline) {
        await step(id, "tell_customer_expired", () => notifier.send(order.customer,
          `We couldn't approve your return for order ${order.order_id} in time, so nothing was refunded. Reply to this message and we'll look again.`,
          `${id}:tell_customer_expired`));
        return finish(id, "expired");
      }
      await db.query("update workflows set status = 'waiting_for_approval', lease_until = null where id = $1", [id]);
      return "waiting_for_approval";
    }
    if (decision.decision === "reject") {
      await step(id, "tell_customer_rejected", () => notifier.send(order.customer,
        `Your return for order ${order.order_id} was not approved. A colleague will contact you.`,
        `${id}:tell_customer_rejected`));
      return finish(id, "rejected");
    }
  }

  // CreateReturn has no idempotency key. So look first, with a reference only this step uses.
  const ret = await step(id, "create_return", async () => {
    const ref = `${id}:create_return`;
    return (await orders.findReturn(ref)) ??
      orders.createReturn({ order_id: order.order_id, amount: input.amount, external_ref: ref });
  });
  await step(id, "tell_customer_done", () => notifier.send(order.customer,
    `Your return ${ret.return_id} for order ${order.order_id} is approved. EUR ${input.amount.toFixed(2)} will be refunded.`,
    `${id}:tell_customer_done`));
  return finish(id, "done");
}

await runChecks({ setup, start, run });
