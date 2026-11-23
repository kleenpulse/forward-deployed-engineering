// Lesson 9 exercise: answer Dana's four questions from the agent's telemetry and the helpdesk.
// Run: bun exercises/0009-telemetry/start.ts
//
// Your job: make every check print PASS. Read the top of harness.ts first: it describes both
// tables and every attribute you need.
import { BASELINE_HOURS, db, PRICES, REPORT_TIME, runChecks, type TeamCost, type WeekShare } from "./harness.ts";

// The deliberately naive version. Every query runs, and every answer looks plausible.

// "Add up the tokens on every span, group by team, multiply by the price."
async function costByTeam(): Promise<TeamCost[]> {
  return (await db.query<TeamCost>(`
    select attrs->>'app.team' as team,
           count(distinct trace_id)::int as runs,
           sum((attrs->>'gen_ai.usage.input_tokens')::int)::int as input_tokens,
           sum((attrs->>'gen_ai.usage.output_tokens')::int)::int as output_tokens,
           (sum((attrs->>'gen_ai.usage.input_tokens')::int) * 3.0 / 1000 +
            sum((attrs->>'gen_ai.usage.output_tokens')::int) * 15.0 / 1000)::float8 as cost_usd
      from spans
     group by 1 order by 1`)).rows;
}

// "Average time to the first response."
async function medianFirstResponseHours(): Promise<number> {
  return (await db.query<{ hours: number }>(`
    select avg(extract(epoch from first_response_at - created_at) / 3600)::float8 as hours from tickets`)).rows[0].hours;
}

// "The agent answered 9 in 10 emails, so they use it."
async function adoptionByWeek(): Promise<WeekShare[]> {
  return (await db.query<WeekShare>(`
    select to_char(date_trunc('week', start_time at time zone 'UTC'), 'YYYY-MM-DD') as week,
           avg((attrs->>'app.result' = 'answered')::int)::float8 as share
      from spans where parent_id is null
     group by 1 order by 1`)).rows;
}

// "Page someone when more than 5% of spans are errors."
async function alerts(): Promise<string[]> {
  return (await db.query<{ day: string }>(`
    select to_char((start_time at time zone 'UTC')::date, 'YYYY-MM-DD') as day
      from spans
     group by 1
    having avg((status = 'error')::int) > 0.05
     order by 1`)).rows.map((r) => r.day);
}

// TODO, in the order of the checks:
//   1. Tokens are on the chat spans AND rolled up onto the root span. Sum them from one place
//      only: spans where gen_ai.operation.name = 'chat'.
//   2. Price each chat span with its own model's prices from PRICES (pass them in as a query
//      parameter). Prices are per MILLION tokens. input_tokens includes the cached tokens, and
//      cached tokens cost input price x cacheRead. So: (input - cache) x input price
//      + cache x input price x cacheRead + output x output price, all / 1,000,000.
//   3. The team is on the root span only, so join each chat span to its run's root span by
//      trace_id. Count live runs only (app.source = 'live'): your eval runs are your cost,
//      not the support team's usage. One row per team, sorted by team.
//   4. The agreed metric: the MEDIAN hours from created_at to first_response_at, for
//      order-status emails only. A ticket nobody has answered yet has waited at least until
//      REPORT_TIME. Count that wait; dropping the ticket makes the number look better than it is.
//   5. Adoption is what people do with the draft: per week (Monday, UTC), the share of
//      order-status tickets with draft = 'used'.
//   6. Alert on the symptom customers feel: per day (UTC), live runs only, fire when more
//      than 20% of runs ended handed_off.
//   7. ...and only when there's enough traffic to mean something: at least 20 live runs that day.
void [BASELINE_HOURS, PRICES, REPORT_TIME];

await runChecks({ costByTeam, medianFirstResponseHours, adoptionByWeek, alerts });
