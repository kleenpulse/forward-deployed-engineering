// Lesson 7 exercise: an approval gate and a workflow that survives crashes.
// Run: bun exercises/0007-approvals/start.ts
//
// Your job: make every check print PASS. Read the top of harness.ts first.
import {
  APPROVAL_LIMIT, APPROVAL_TIMEOUT_HOURS, APPROVERS, db, notifier, now, orders, runChecks,
  type ReturnInput, type Status,
} from "./harness.ts";

async function setup() {
  await db.exec(`
    create table workflows (
      id     text primary key,
      input  jsonb not null,
      status text not null
    );
  `);
}

async function start(input: ReturnInput): Promise<string> {
  const id = `wf-${crypto.randomUUID().slice(0, 8)}`;
  await db.query("insert into workflows (id, input, status) values ($1, $2, 'running')", [id, input]);
  return id;
}

// The deliberately naive version: one function, straight through, everything in memory.
// "The agent already asked the user in the chat, so it's approved."
async function run(id: string): Promise<Status> {
  const { input } = (await db.query<{ input: ReturnInput }>("select input from workflows where id = $1", [id])).rows[0];
  const order = await orders.getOrder(input.order_id);
  const ret = await orders.createReturn({ order_id: input.order_id, amount: input.amount, external_ref: id });
  await notifier.send(order.customer, `Your return ${ret.return_id} for order ${order.order_id} is on its way.`);
  await db.query("update workflows set status = 'done' where id = $1", [id]);
  return "done";
}

// TODO, in the order of the checks:
//   1. Gate: if input.amount >= APPROVAL_LIMIT, insert a row into approval_requests (once) with a
//      summary a manager can decide from, and return "waiting_for_approval". Don't block or poll:
//      run() returns, and the approval app calls run() again after someone clicks.
//   2. Read approval_decisions for this workflow. A "reject" ends it: status "rejected".
//   3. Only count decisions whose decided_by is in APPROVERS. The agent can't approve itself.
//   4. Checkpoint every step: a steps table keyed by (workflow_id, step), storing the step's
//      result as JSON. A helper like step(id, "look_up_order", () => orders.getOrder(...)) returns
//      the saved result if the step already ran, and runs and saves it if not. Finished
//      workflows return their saved status without doing anything.
//   5. CreateReturn has no idempotency key, so a crash right after it leaves you not knowing
//      whether it happened. Inside the step, look first: orders.findReturn(ref) with a ref unique
//      to this workflow and step. Only create if nothing is found. Give the notifier a dedupe key.
//   6. Two run() calls at once must not both do the work. Let one claim the workflow first,
//      atomically: update workflows set lease_until = ... where id = $1 and (lease_until is null
//      or lease_until < $2) returning id. If you get no row back, someone else is running it.
//      Release the lease when you finish. Keep the lease short (30 seconds of now()).
//   7. If no valid decision arrives within APPROVAL_TIMEOUT_HOURS of the request, the workflow
//      is "expired": tell the customer it wasn't processed, and ignore any later click.
//   Use now() from harness.ts for every timestamp.
void [APPROVAL_LIMIT, APPROVAL_TIMEOUT_HOURS, APPROVERS, now];

await runChecks({ setup, start, run });
