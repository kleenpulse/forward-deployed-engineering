// Lesson 8 exercise: grade the agent on Acme's own emails, and decide whether v2 may ship.
// Run: bun exercises/0008-evals/start.ts
//
// Your job: make every check print PASS. Read the top of harness.ts first, then open
// data/golden.json and a few lines of data/runs.jsonl.
import { runChecks, WRITE_TOOLS, type Case, type Decision, type Grade, type Run, type Summary, type Verdict } from "./harness.ts";

// The deliberately naive grader: "if the reply mentions what we expected, it passed".
function grade(c: Case, run: Run): Verdict {
  const reply = run.reply.toLowerCase();
  const missing = c.expect.must_say.filter((p) => !reply.includes(p.toLowerCase()));
  return { pass: missing.length === 0, reasons: missing.map((p) => `doesn't say "${p}"`) };
}

// "The share of runs that passed is the score."
function summarize(grades: Grade[]): Summary {
  const cases = new Set(grades.map((g) => g.case_id)).size;
  const rate = grades.filter((g) => g.pass).length / grades.length;
  return { cases, trials: grades.length / cases, passAt1: rate, passAtK: rate, passHatK: rate };
}

// "The higher score wins."
function decide(before: Grade[], after: Grade[]): Decision {
  return { ship: summarize(after).passAt1 >= summarize(before).passAt1, regressions: [] };
}

// TODO, in the order of the checks:
//   1. A reply can contain every right word and still be wrong ("hasn't shipped"). Fail the run
//      if the reply contains any of c.expect.must_not_say (any letter case).
//   2. Grade the tool calls, not only the reply. Writes are exact: every call to a tool in
//      WRITE_TOOLS must match one of c.expect.returns (same order_id, same amount), and every
//      expected return must happen. A write with the wrong amount fails, however good the reply.
//   3. Reads are free: don't demand one exact sequence of calls. Extra get_order or list_returns
//      calls are fine. A second start_return is not: that's a second workflow.
//   4. Every order in c.expect.lookups must have been read with get_order and that exact id.
//      (Checks 4 and 5 should pass once 1 to 3 work. Read their details anyway.)
//   5. Give a reason for every failure. You'll read these reasons, and so will the customer.
//   6. summarize(): k runs per case. pass@1 is the share of all runs that passed. pass@k is the
//      share of cases where at least one run passed. pass^k is the share where all k passed.
//   7. decide(): a regression is a case that passed every run before and fails any run after.
//      Ship only if there are no regressions and pass^k didn't go down.
void WRITE_TOOLS;

await runChecks({ grade, summarize, decide });
