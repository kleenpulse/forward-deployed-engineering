// Lesson 9 exercise: a worked solution. Try start.ts first.
// Run: bun exercises/0009-telemetry/solution.ts
import { db, PRICES, REPORT_TIME, runChecks, type TeamCost, type WeekShare } from "./harness.ts";

const prices = JSON.stringify(Object.entries(PRICES).map(([model, p]) =>
  ({ model, input: p.input, output: p.output, cache_read: p.cacheRead })));

async function costByTeam(): Promise<TeamCost[]> {
  return (await db.query<TeamCost>(`
    with prices as (
      select * from jsonb_to_recordset($1::jsonb) as p(model text, input numeric, output numeric, cache_read numeric)
    ),
    runs as (   -- the team and the source live on the root span only
      select trace_id, attrs->>'app.team' as team
        from spans
       where parent_id is null and attrs->>'app.source' = 'live'
    ),
    chats as (  -- tokens come from the chat spans, never from the root's roll-up
      select trace_id,
             attrs->>'gen_ai.request.model' as model,
             (attrs->>'gen_ai.usage.input_tokens')::bigint as input,
             (attrs->>'gen_ai.usage.cache_read.input_tokens')::bigint as cache,
             (attrs->>'gen_ai.usage.output_tokens')::bigint as output
        from spans
       where attrs->>'gen_ai.operation.name' = 'chat'
    )
    select r.team,
           count(distinct r.trace_id)::int as runs,
           sum(c.input)::int as input_tokens,
           sum(c.output)::int as output_tokens,
           sum(((c.input - c.cache) * p.input          -- uncached input, full price
                + c.cache * p.input * p.cache_read     -- cached input, discounted
                + c.output * p.output) / 1e6)::float8 as cost_usd   -- prices are per million
      from runs r
      join chats c using (trace_id)
      join prices p using (model)
     group by r.team
     order by r.team`, [prices])).rows;
}

async function medianFirstResponseHours(): Promise<number> {
  return (await db.query<{ hours: number }>(`
    select percentile_cont(0.5) within group (
             order by extract(epoch from coalesce(first_response_at, $1::timestamptz) - created_at) / 3600
           )::float8 as hours
      from tickets
     where category = 'order_status'`, [REPORT_TIME])).rows[0].hours;
}

async function adoptionByWeek(): Promise<WeekShare[]> {
  return (await db.query<WeekShare>(`
    select to_char(date_trunc('week', created_at at time zone 'UTC'), 'YYYY-MM-DD') as week,
           avg((draft = 'used')::int)::float8 as share
      from tickets
     where category = 'order_status'
     group by 1 order by 1`)).rows;
}

async function alerts(): Promise<string[]> {
  return (await db.query<{ day: string }>(`
    select to_char((start_time at time zone 'UTC')::date, 'YYYY-MM-DD') as day
      from spans
     where parent_id is null and attrs->>'app.source' = 'live'
     group by 1
    having count(*) >= 20                                            -- enough traffic to mean something
       and avg((attrs->>'app.result' = 'handed_off')::int) > 0.2      -- the symptom, not the cause
     order by 1`)).rows.map((r) => r.day);
}

await runChecks({ costByTeam, medianFirstResponseHours, adoptionByWeek, alerts });
