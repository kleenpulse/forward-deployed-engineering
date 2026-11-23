// Lesson 4 exercise: permission-filtered retrieval.
// Run: bun exercises/0004-retrieval/start.ts
//
// Your job: write search(user, query) so that every check prints PASS.
// The corpus, the users and the checks live in harness.ts. Read it once.
import { runChecks, sql, type Result, type User } from "./harness.ts";

// Turns "refund policy" into 'refund' | 'polici': a document matches if it has ANY of
// the words, and ts_rank scores it higher the more it has.
export const OR_QUERY = `cast(replace(plainto_tsquery('english', $1)::text, ' & ', ' | ') as tsquery)`;

// The deliberately bad version: rank everything, keep the top 3, THEN filter in app code.
async function searchNaive(user: User, query: string): Promise<Result> {
  const rows = await sql<{ id: string; tenant: string; acl: string[]; body: string; score: number }>(
    `select id, tenant, acl, body, ts_rank(tsv, q) as score
       from docs, ${OR_QUERY} as q
      where tsv @@ q
      order by score desc
      limit 3`,
    [query],
  );
  // By now every row above has already left the database: into this process's memory,
  // and into whatever logs, traces or prompts touch `rows`.
  const allowed = rows.filter((r) => r.tenant === user.tenant && r.acl.some((g) => user.groups.includes(g)));
  // Returns passages with no source, so nothing can be cited. No threshold either.
  return { abstained: allowed.length === 0, hits: allowed.map((r) => ({ text: r.body, score: r.score }) as any) };
}

// TODO: replace the body of search().
//   1. Filter by tenant and by the user's groups INSIDE the database, before ranking.
//      Either: enable row-level security on docs, write a policy that reads the user from
//      current_setting(...), and run the query as app_user in a transaction
//      (begin; set local role app_user; select set_config('app.tenant', ..., true); ...).
//      Or: add an explicit WHERE on tenant and acl to the ranking query.
//   2. Return id, title and score for each hit, so the answer can cite its sources.
//   3. Drop hits scoring below MIN_SCORE. If none are left, abstain.
//   Always use sql() from harness.ts, so the checks can see what left the database.
const MIN_SCORE = 0.05;

async function search(user: User, query: string): Promise<Result> {
  void MIN_SCORE;
  return searchNaive(user, query);
}

await runChecks(search);
