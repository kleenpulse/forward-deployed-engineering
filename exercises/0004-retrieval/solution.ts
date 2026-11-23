// Lesson 4 exercise: worked solution, using Postgres row-level security.
// Run: bun exercises/0004-retrieval/solution.ts
import { db, runChecks, sql, type Hit, type Result, type User } from "./harness.ts";

const OR_QUERY = `cast(replace(plainto_tsquery('english', $1)::text, ' & ', ' | ') as tsquery)`;
const MIN_SCORE = 0.05; // tuned on this corpus; ts_rank scores have no fixed scale

// 1. The rule lives in the database. With RLS enabled and no policy, app_user sees nothing
//    (default deny). The policy lets a row through only if it belongs to the caller's tenant
//    AND shares at least one group with the caller. current_setting(name, true) returns
//    NULL when the setting is missing, and NULL never passes, so a forgotten setting fails closed.
await db.exec(`
  alter table docs enable row level security;
  create policy tenant_and_groups on docs for select to app_user
    using (
      tenant = current_setting('app.tenant', true)
      and acl && string_to_array(current_setting('app.groups', true), ',')
    );
`);

async function search(user: User, query: string): Promise<Result> {
  await sql("begin");
  try {
    // 2. Become the restricted role and say who is asking, for this transaction only
    //    ("local" / third argument true), so the next request on this connection starts clean.
    await sql("set local role app_user");
    await sql("select set_config('app.tenant', $1, true), set_config('app.groups', $2, true)",
      [user.tenant, user.groups.join(",")]);

    // 3. The same ranking query as searchNaive, with nothing added. RLS filters the rows
    //    as they are read, before ORDER BY and LIMIT, so forbidden rows can't take a top slot.
    const hits = await sql<Hit>(
      `select id, title, ts_rank(tsv, q) as score
         from docs, ${OR_QUERY} as q
        where tsv @@ q
        order by score desc
        limit 3`,
      [query],
    );
    await sql("commit");

    // 4. Abstain below the threshold instead of guessing from a weak match.
    const good = hits.filter((h) => h.score >= MIN_SCORE);
    return { abstained: good.length === 0, hits: good };
  } catch (e) {
    await sql("rollback");
    throw e;
  }
}

await runChecks(search);
