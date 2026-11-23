// Shared setup and checks for Lesson 3. You don't need to edit this file.
// start.ts and solution.ts each pass their policy SQL to run().
//
// The story: one database serves two customers (tenants), Acme and Globex.
// An AI agent answers questions from their documents. The agent connects as one
// low-privilege Postgres role, "agent", and before every query the app tells the
// database which human the agent is working for: set_config('app.user_id', ...).
// Row-level security then decides which rows that human may see.
import { PGlite } from "@electric-sql/pglite";

const SCHEMA = /* sql */ `
  -- Who people are. In production SCIM keeps this table in sync with the
  -- customer's identity provider: new hires appear, leavers get active = false.
  create table app_users (
    id         text primary key,
    email      text not null,
    tenant     text not null,                     -- which customer they belong to
    department text not null,
    role       text not null check (role in ('member', 'admin')),
    active     boolean not null default true
  );

  create table docs (
    id         int primary key,
    tenant     text not null,
    department text not null,
    title      text not null
  );

  insert into app_users values
    ('u-ana',  'ana@acme.example',   'acme',   'finance', 'member', true),
    ('u-ben',  'ben@acme.example',   'acme',   'hr',      'member', true),
    ('u-omar', 'omar@acme.example',  'acme',   'it',      'admin',  true),
    ('u-lee',  'lee@acme.example',   'acme',   'finance', 'member', false), -- left last week
    ('u-gia',  'gia@globex.example', 'globex', 'finance', 'member', true);

  insert into docs values
    (1, 'acme',   'finance', 'Q3 budget'),
    (2, 'acme',   'finance', 'Vendor payment run'),
    (3, 'acme',   'hr',      'Salary bands 2026'),
    (4, 'acme',   'hr',      'Disciplinary case notes'),
    (5, 'acme',   'support', 'Refund policy'),
    (6, 'globex', 'finance', 'Globex Q3 budget'),
    (7, 'globex', 'hr',      'Globex salary bands');

  -- The agent's database role: no superuser, no BYPASSRLS, not the table owner.
  create role agent;
  grant select on docs, app_users to agent;
`;

// The agent's "search" tool. It asks for everything on purpose: the database,
// not the prompt, must decide what comes back.
const AGENT_QUERY = "select id from docs order by id";

async function agentQuery(db: PGlite, userId: string | null): Promise<number[]> {
  return db.transaction(async (tx) => {
    // true = this setting only lasts until the end of this transaction.
    if (userId !== null) await tx.query("select set_config('app.user_id', $1, true)", [userId]);
    await tx.exec("set local role agent");
    const { rows } = await tx.query<{ id: number }>(AGENT_QUERY);
    return rows.map((r) => r.id);
  });
}

type Case = { name: string; user: string | null; expect: number[] };

const CASES: Case[] = [
  { name: "Ana (Acme finance) sees Acme's finance docs", user: "u-ana", expect: [1, 2] },
  { name: "Ben (Acme HR) sees only Acme's HR docs", user: "u-ben", expect: [3, 4] },
  { name: "Omar (Acme admin) sees every Acme doc", user: "u-omar", expect: [1, 2, 3, 4, 5] },
  { name: "Gia (Globex finance) sees only Globex finance", user: "u-gia", expect: [6] },
  { name: "Lee (deactivated by SCIM) sees nothing", user: "u-lee", expect: [] },
  { name: "Unknown user id sees nothing", user: "u-999", expect: [] },
  { name: "No user set (agent forgot) sees nothing", user: null, expect: [] },
];

const stripSqlComments = (sql: string) => sql.replace(/--.*$/gm, "").trim();
const fmt = (ids: number[]) => `[${ids.join(",")}]`;

export async function run(policySql: string) {
  const db = new PGlite();
  await db.exec(SCHEMA);
  if (stripSqlComments(policySql)) await db.exec(policySql);

  let passed = 0;
  for (const c of CASES) {
    const got = await agentQuery(db, c.user);
    const ok = fmt(got) === fmt(c.expect);
    if (ok) passed++;
    const detail = ok ? `got ${fmt(got)}` : `expected ${fmt(c.expect)}, got ${fmt(got)}`;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(48)} ${detail}`);
  }
  console.log(`\n${passed}/${CASES.length} passed`);
  await db.close();
  if (passed < CASES.length) process.exitCode = 1;
}
