// Shared setup and checks for the Lesson 4 exercise. You don't need to edit this file.
// start.ts and solution.ts both import it.
import { PGlite } from "@electric-sql/pglite";

export type User = { name: string; tenant: string; groups: string[] };
export type Hit = { id: string; title: string; score: number };
// abstained: true means "I couldn't find anything you may see that answers this".
export type Result = { abstained: boolean; hits: Hit[] };
export type Search = (user: User, query: string) => Promise<Result>;

export const users = {
  alice: { name: "alice", tenant: "acme", groups: ["everyone", "support"] },
  hank: { name: "hank", tenant: "acme", groups: ["everyone", "hr"] },
  gina: { name: "gina", tenant: "globex", groups: ["everyone"] },
} satisfies Record<string, User>;

// Two customers (tenants) share one table. acl = the groups allowed to read the document.
type Doc = { id: string; tenant: string; title: string; acl: string[]; body: string };
const docs: Doc[] = [
  { id: "acme-1", tenant: "acme", title: "Refund policy", acl: ["everyone"],
    body: "Customers can get their money back within 30 days of purchase. Start a refund from the support portal." },
  { id: "acme-2", tenant: "acme", title: "Refund fraud review, Q3", acl: ["finance"],
    body: "Finance found 14 refund requests from one card. Refund fraud cases are frozen. Exceptions to the refund policy need finance approval." },
  { id: "acme-3", tenant: "acme", title: "Salary bands 2026", acl: ["hr"],
    body: "Salary bands for every role. Senior engineers sit in band E4. Salary reviews happen in March." },
  { id: "acme-4", tenant: "acme", title: "Payroll FAQ", acl: ["everyone"],
    body: "Your salary is paid on the 25th of each month. Payslips are in the HR portal." },
  { id: "acme-5", tenant: "acme", title: "Office holidays", acl: ["everyone"],
    body: "The office is closed on public holidays and between Christmas and New Year." },
  { id: "globex-1", tenant: "globex", title: "Refund policy", acl: ["everyone"],
    body: "Globex refund policy: refunds within 14 days, as store credit only. No cash refund after 14 days." },
  { id: "globex-2", tenant: "globex", title: "Reseller refund policy", acl: ["everyone"],
    body: "Resellers get a refund only for damaged stock. The reseller refund policy overrides the store refund policy." },
];

export const db = new PGlite();
await db.exec(`
  create table docs (
    id     text primary key,
    tenant text not null,
    title  text not null,
    acl    text[] not null,
    body   text not null,
    tsv    tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored
  );
  create index docs_tsv on docs using gin (tsv);
  -- The role the app uses for searches. It is not a superuser and doesn't own the table,
  -- so row-level security applies to it.
  create role app_user;
  grant select on docs to app_user;
`);
for (const d of docs) {
  await db.query("insert into docs (id, tenant, title, acl, body) values ($1, $2, $3, $4, $5)",
    [d.id, d.tenant, d.title, d.acl, d.body]);
}

// Every query goes through sql(). It records each document id that leaves the database,
// the way a log line, a trace or the model's prompt would see it.
let leftTheDatabase: string[] = [];
export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await db.query<T>(text, params);
  for (const r of rows as any[]) if (typeof r?.id === "string") leftTheDatabase.push(r.id);
  return rows;
}

const mayRead = (u: User, id: string) => {
  const d = docs.find((x) => x.id === id)!;
  return d.tenant === u.tenant && d.acl.some((g) => u.groups.includes(g));
};

export async function runChecks(search: Search) {
  const results: [boolean, string, string][] = [];
  const run = async (u: User, q: string) => {
    leftTheDatabase = [];
    const r = await search(u, q);
    return { r, left: [...leftTheDatabase] };
  };
  const show = (r: Result) => (r.abstained ? "abstained" : r.hits.map((h) => h.id ?? "(passage with no id)").join(", ") || "nothing");

  // 1. No cross-tenant leak: a Globex document never leaves the database for an Acme user, and back.
  {
    const a = await run(users.alice, "refund policy");
    const g = await run(users.gina, "refund policy");
    const bad = [
      ...a.left.filter((id) => !id.startsWith("acme-")),
      ...g.left.filter((id) => !id.startsWith("globex-")),
    ];
    results.push([bad.length === 0, "No cross-tenant leak",
      bad.length ? `rows from the other tenant left the database: ${[...new Set(bad)].join(", ")}` : "each user only ever touched their own tenant"]);
  }

  // 2. No restricted document: alice (support) never touches HR or finance rows.
  {
    const bad = new Set<string>();
    for (const q of ["refund policy", "salary bands"]) {
      const { r, left } = await run(users.alice, q);
      for (const id of [...left, ...r.hits.map((h) => h.id)].filter(Boolean)) if (!mayRead(users.alice, id)) bad.add(id);
    }
    results.push([bad.size === 0, "No restricted document",
      bad.size ? `alice's searches pulled rows she may not read: ${[...bad].join(", ")}` : "alice never touched an HR or finance row"]);
  }

  // 3. The right document ranks first for a permitted user.
  {
    const a = await run(users.alice, "refund policy");
    const h = await run(users.hank, "salary bands");
    const ok = a.r.hits[0]?.id === "acme-1" && h.r.hits[0]?.id === "acme-3";
    results.push([ok, "Right document first",
      `alice "refund policy" -> ${show(a.r)} (want acme-1); hank "salary bands" -> ${show(h.r)} (want acme-3)`]);
  }

  // 4. Abstains when only forbidden documents match well.
  {
    const { r } = await run(users.alice, "salary bands");
    const ok = r.abstained && r.hits.length === 0;
    results.push([ok, "Abstains when nothing permitted matches",
      `alice "salary bands" -> ${show(r)} (want abstained)`]);
  }

  // 5. Every hit carries a citation: the document's id and title.
  {
    const all: Hit[] = [];
    for (const [u, q] of [[users.alice, "refund policy"], [users.hank, "salary bands"], [users.alice, "when is my salary paid"]] as const) {
      const { r } = await run(u, q);
      if (!r.abstained && r.hits.length === 0) all.push({} as Hit); // answered with nothing to cite
      all.push(...r.hits);
    }
    const bad = all.filter((h) => !h.id || !h.title);
    results.push([all.length > 0 && bad.length === 0, "Every hit carries a citation",
      bad.length ? `${bad.length} of ${all.length} hits have no id or title to cite` : `${all.length} hits, all with id and title`]);
  }

  for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  const passed = results.filter(([ok]) => ok).length;
  console.log(`\n${passed}/${results.length} checks pass.`);
  await db.close();
}
