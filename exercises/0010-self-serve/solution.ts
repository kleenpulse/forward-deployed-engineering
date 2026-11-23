// Lesson 10 exercise: a worked solution. Try start.ts first.
// Run: bun exercises/0010-self-serve/solution.ts
import {
  ADMIN_GROUP, APPROVER_GROUP, db, INITIAL, LIMIT_MAX_EUR, now, runChecks, runGoldenSet,
  type Result, type Settings, type Version,
} from "./harness.ts";

const KEYS = ["approvers", "approval_limit_eur", "prompt"];

async function setup() {
  // One row per version, never updated. The newest row is what the agent runs on.
  await db.exec(`
    create table settings_versions (
      version  int primary key,
      settings jsonb not null,
      actor    text not null,
      reason   text not null,
      at       timestamptz not null
    )`);
  await db.query("insert into settings_versions values (1, $1::jsonb, 'setup', 'Settings at the end of the pilot', $2)",
    [JSON.stringify(INITIAL), now().toISOString()]);
}

type Row = { version: number; settings: Settings; actor: string; reason: string; at: Date };
const toVersion = (r: Row): Version => ({ ...r, at: r.at.toISOString() });

async function current(): Promise<Version> {
  const { rows } = await db.query<Row>("select * from settings_versions order by version desc limit 1");
  return toVersion(rows[0]);
}

async function history(): Promise<Version[]> {
  return (await db.query<Row>("select * from settings_versions order by version")).rows.map(toVersion);
}

async function activeMembers(group: string): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>("select id from directory where active and $1 = any(groups)", [group]);
  return new Set(rows.map((r) => r.id));
}

/** Every rule a new set of settings must pass. Returns the reason it can't be saved, or null. */
async function problem(actor: string, cur: Settings, next: Record<string, unknown>): Promise<string | null> {
  if (!(await activeMembers(ADMIN_GROUP)).has(actor)) {
    return `${actor} can't change the agent's settings. Ask someone in ${ADMIN_GROUP}.`;
  }
  const unknown = Object.keys(next).filter((k) => !KEYS.includes(k));
  if (unknown.length) return `There is no setting called ${unknown.join(", ")}. The settings are ${KEYS.join(", ")}.`;

  const limit = next.approval_limit_eur;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0 || limit > LIMIT_MAX_EUR) {
    return `The approval limit must be a number from 0 to ${LIMIT_MAX_EUR} EUR (Acme's finance policy). Got ${JSON.stringify(limit)}.`;
  }

  const approvers = next.approvers;
  if (!Array.isArray(approvers) || approvers.length === 0) {
    return "There must be at least one approver, or every big return waits 48 hours and expires.";
  }
  const managers = await activeMembers(APPROVER_GROUP);
  const notManagers = approvers.filter((a) => typeof a !== "string" || !managers.has(a));
  if (notManagers.length) {
    return `${notManagers.join(", ")} can't approve returns: an approver must be an active member of ${APPROVER_GROUP}.`;
  }

  if (typeof next.prompt !== "string" || next.prompt.trim() === "") return "The prompt can't be empty.";
  if (next.prompt !== cur.prompt) {
    const [before, after] = await Promise.all([runGoldenSet(cur.prompt), runGoldenSet(next.prompt)]);
    const broken = after.filter((c) => !c.pass && before.find((b) => b.id === c.id)?.pass).map((c) => c.id);
    if (broken.length) {
      return `This prompt breaks golden-set cases that pass today: ${broken.join(", ")}. Nothing was changed.`;
    }
  }
  return null;
}

/** The one way settings change. change() and rollback() both come through here. */
async function apply(actor: string, action: "change" | "rollback", detail: unknown, reason: string,
  next: (cur: Settings) => Promise<Record<string, unknown> | string>): Promise<Result> {
  const cur = await current();
  const proposed = await next(cur.settings);
  const error = typeof proposed === "string" ? proposed : await problem(actor, cur.settings, proposed);
  const version = error ? null : cur.version + 1;
  // version is the primary key, so if two admins save at once, the second insert fails
  // instead of silently overwriting the first.
  if (version) {
    await db.query("insert into settings_versions values ($1, $2::jsonb, $3, $4, $5)",
      [version, JSON.stringify(proposed), actor, reason, now().toISOString()]);
  }
  await db.query(
    "insert into audit_log (at, actor, action, detail, reason, outcome, version, error) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)",
    [now().toISOString(), actor, action, JSON.stringify(detail), reason, error ? "refused" : "applied", version, error]);
  return error ? { ok: false, error } : { ok: true, version: version! };
}

async function change(actor: string, patch: Record<string, unknown>, reason: string): Promise<Result> {
  return apply(actor, "change", patch, reason, async (cur) => ({ ...cur, ...patch }));
}

async function rollback(actor: string, to: number, reason: string): Promise<Result> {
  return apply(actor, "rollback", { to_version: to }, reason, async () => {
    const { rows } = await db.query<{ settings: Settings }>("select settings from settings_versions where version = $1", [to]);
    return rows[0]?.settings ?? `There is no version ${to}.`;
  });
}

await runChecks({ setup, current, history, change, rollback });
