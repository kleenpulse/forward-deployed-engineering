// Lesson 3 exercise: worked solution.
// Run: bun exercises/0003-identity/solution.ts
import { run } from "./harness";

const POLICY_SQL = /* sql */ `
  -- With RLS on and no policy, the agent would see nothing (default deny).
  alter table docs enable row level security;

  -- One permissive policy: a row is visible if the human the agent works for
  -- is active, in the same tenant, and either an admin or in the same department.
  -- The role and active flag are read from app_users on every query, so when
  -- SCIM deactivates someone, the agent loses their access at once.
  create policy agent_reads_docs on docs
    for select
    to agent
    using (
      exists (
        select 1
        from app_users u
        where u.id = current_setting('app.user_id', true)
          and u.active
          and u.tenant = docs.tenant
          and (u.role = 'admin' or u.department = docs.department)
      )
    );
`;

await run(POLICY_SQL);
