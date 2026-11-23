// Lesson 8 exercise: a worked solution. Try start.ts first.
// Run: bun exercises/0008-evals/solution.ts
import { runChecks, WRITE_TOOLS, type Case, type Decision, type Grade, type Run, type Summary, type Verdict } from "./harness.ts";

/** Grades one run against what Luis's team agreed is correct. Code only, no model. */
function grade(c: Case, run: Run): Verdict {
  const { lookups, returns, must_say, must_not_say } = c.expect;
  const reasons: string[] = [];

  // Reads are free: any order, any number of times. The ones the answer depends on must happen.
  for (const id of lookups)
    if (!run.calls.some((k) => k.tool === "get_order" && k.args.order_id === id)) reasons.push(`never read order ${id}`);

  // Writes are exact: each write must match an expected return, and each expected return must happen once.
  const expected = [...returns];
  for (const w of run.calls.filter((k) => WRITE_TOOLS.includes(k.tool))) {
    const i = expected.findIndex((r) => r.order_id === w.args.order_id && Math.abs(r.amount - Number(w.args.amount)) < 0.005);
    if (i === -1) reasons.push(`unexpected write ${w.tool}(${w.args.order_id}, ${w.args.amount})`);
    else expected.splice(i, 1);
  }
  for (const r of expected) reasons.push(`never started the return on ${r.order_id} for ${r.amount}`);

  // The reply: every fact the team requires, and none of the wrong claims they've seen before.
  const reply = run.reply.toLowerCase();
  for (const p of must_say) if (!reply.includes(p.toLowerCase())) reasons.push(`doesn't say "${p}"`);
  for (const p of must_not_say) if (reply.includes(p.toLowerCase())) reasons.push(`says "${p}"`);

  return { pass: reasons.length === 0, reasons };
}

/** case_id -> pass/fail of each run, in trial order. */
function byCase(grades: Grade[]): Map<string, boolean[]> {
  const m = new Map<string, boolean[]>();
  for (const g of [...grades].sort((a, b) => a.trial - b.trial)) m.set(g.case_id, [...(m.get(g.case_id) ?? []), g.pass]);
  return m;
}

function summarize(grades: Grade[]): Summary {
  const runs = [...byCase(grades).values()];
  return {
    cases: runs.length,
    trials: Math.max(...runs.map((r) => r.length)),
    passAt1: grades.filter((g) => g.pass).length / grades.length,
    passAtK: runs.filter((r) => r.some(Boolean)).length / runs.length, // at least one run passed
    passHatK: runs.filter((r) => r.every(Boolean)).length / runs.length, // every run passed
  };
}

function decide(before: Grade[], after: Grade[]): Decision {
  const now = byCase(after);
  // A case that always worked and now fails, even once, or wasn't run at all.
  const regressions = [...byCase(before)]
    .filter(([id, was]) => was.every(Boolean) && !(now.get(id)?.every(Boolean) ?? false))
    .map(([id]) => id)
    .sort();
  return { ship: regressions.length === 0 && summarize(after).passHatK >= summarize(before).passHatK, regressions };
}

await runChecks({ grade, summarize, decide });
