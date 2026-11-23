// Lesson 3 exercise: stop the agent from reading rows its human may not see.
// Run: bun exercises/0003-identity/start.ts
//
// Right now the "agent" role can read every row of every customer. That is the
// god-mode service account the lesson warns about. Write the SQL below so that,
// when the agent works for a user, it only sees:
//   - docs from the user's own tenant, never another customer's;
//   - docs from the user's own department, unless the user's role is 'admin';
//   - nothing at all if the user is inactive, unknown, or not set.
//
// You have:
//   current_setting('app.user_id', true)  -> the signed-in human's id, or NULL/'' if unset
//   app_users(id, tenant, department, role, active)
//   docs(id, tenant, department, title)
//
// Hints: you need two statements. Postgres docs:
// https://www.postgresql.org/docs/current/ddl-rowsecurity.html
import { run } from "./harness";

const POLICY_SQL = /* sql */ `
  -- TODO 1: turn on row-level security for the docs table.

  -- TODO 2: create a SELECT policy for the agent role on docs.
  --         Its USING (...) expression is checked against every row.
`;

await run(POLICY_SQL);
