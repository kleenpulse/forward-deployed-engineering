// Lesson 10 exercise: the admin API Acme's staff use to change the agent after you leave.
// Run: bun exercises/0010-self-serve/start.ts
//
// Your job: make every check print PASS. Read the top of harness.ts first: it describes the
// settings, the directory, the golden set and the audit_log table.
import { db, INITIAL, now, runChecks, type Result, type Settings, type Version } from "./harness.ts";

// The deliberately naive version: one row of settings, updated in place. It's what most
// "admin pages" start as, and it works fine on the day you hand it over.

async function setup() {
  // "Last changed by" and "when", so we know who did it.
  await db.exec("create table settings (id int primary key, data jsonb not null, updated_by text not null, updated_at timestamptz not null)");
  await db.query("insert into settings values (1, $1::jsonb, 'setup', $2)", [JSON.stringify(INITIAL), now().toISOString()]);
}

async function current(): Promise<Version> {
  const { rows } = await db.query<{ data: Settings; updated_by: string; updated_at: Date }>("select * from settings where id = 1");
  return { version: 1, settings: rows[0].data, actor: rows[0].updated_by, reason: "", at: rows[0].updated_at.toISOString() };
}

async function history(): Promise<Version[]> {
  return [await current()];
}

// "Merge whatever the form sent into the settings."
async function change(actor: string, patch: Record<string, unknown>, reason: string): Promise<Result> {
  await db.query("update settings set data = data || $1::jsonb, updated_by = $2, updated_at = $3 where id = 1",
    [JSON.stringify(patch), actor, now().toISOString()]);
  return { ok: true, version: 1 };
}

async function rollback(actor: string, toVersion: number, reason: string): Promise<Result> {
  return { ok: false, error: "Rollback isn't supported. Email the vendor." };
}

// TODO, in the order of the checks:
//   1. Never update in place. Each change inserts a new version row with the full settings,
//      who (actor), why (reason) and when (now() from harness.ts). current() is the newest.
//      setup() saves INITIAL as version 1, by actor "setup".
//   2. rollback(actor, n, reason) copies version n's settings into a NEW version. History keeps
//      everything, including the version you rolled back from. A version that doesn't exist
//      is refused. A rollback is a change: it goes through the same checks as any other.
//   3. Only someone in the directory who is active AND in ADMIN_GROUP may change or roll back.
//      The agent's service account isn't, whatever an email asks it to do.
//   4. Each approver must be an active member of APPROVER_GROUP, and the list can't be empty.
//   5. Accept only the three known keys. approval_limit_eur must be a number from 0 to
//      LIMIT_MAX_EUR. A string, even "600", is refused.
//   6. When the prompt changes, run the golden set on the current prompt and on the new one
//      (runGoldenSet). Refuse the change if any case that passed before fails after, and name
//      those cases in the error. Cases that already failed don't block it.
//   7. Write one audit_log row for EVERY call to change() or rollback(), applied or refused:
//      actor, action, detail (the patch, or {"to_version": n}), reason, outcome, and the new
//      version or the error.
// Refuse with { ok: false, error } in words Luis understands. Never throw for a bad request.

await runChecks({ setup, current, history, change, rollback });
