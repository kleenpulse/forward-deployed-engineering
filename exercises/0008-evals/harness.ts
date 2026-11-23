// Shared setup and checks for the Lesson 8 exercise. You don't need to edit this file.
//
// Acme wants a new version of the support agent (v2: a warmer prompt, and it now cleans up
// order ids like "a-1002 "). Before v2 goes live, you have to show, with Acme's own emails,
// that it is at least as good as v1, which is live today.
//
// You have two files in data/:
//   golden.json  eight real October emails, each with the outcome Luis Romero's support team
//                agreed is correct. Read its "about" line first.
//   runs.jsonl   one line per run: the agent (v1 or v2) answered each email three times. Each
//                run lists the tool calls it made, with their arguments and results, and the
//                reply it sent. These are transcripts, exported from the agent's logs.
//
// The agent's tools:
//   get_order(order_id)            reads. Returns the order, or an error if there is none.
//   list_returns(order_id)         reads. Returns the returns already started on the order.
//   start_return(order_id, amount) WRITES. Starts the returns workflow from Lesson 7, which
//                                  asks a manager first at EUR 500 or more.
//
// You write three functions (see start.ts): grade() one run, summarize() many grades, and
// decide() whether v2 may replace v1.

export type Call = { tool: string; args: Record<string, unknown>; result: unknown };
export type Run = { run_id: string; version: string; case_id: string; trial: number; calls: Call[]; reply: string };
export type Expect = {
  lookups: string[];
  returns: { order_id: string; amount: number }[];
  must_say: string[];
  must_not_say: string[];
};
export type Case = { id: string; category: string; message: string; expect: Expect };
export type Verdict = { pass: boolean; reasons: string[] };
export type Grade = { case_id: string; trial: number; pass: boolean };
export type Summary = {
  cases: number;
  trials: number; // runs per case (k)
  passAt1: number; // share of all runs that passed
  passAtK: number; // share of cases where at least one of the k runs passed
  passHatK: number; // share of cases where all k runs passed
};
export type Decision = { ship: boolean; regressions: string[] };
export type Grader = {
  grade: (c: Case, run: Run) => Verdict;
  summarize: (grades: Grade[]) => Summary;
  decide: (before: Grade[], after: Grade[]) => Decision;
};

/** Tools that change something in Acme's systems. Every other tool only reads. */
export const WRITE_TOOLS = ["start_return"];

export const golden: Case[] = (await Bun.file(new URL("./data/golden.json", import.meta.url)).json()).cases;
export const runs: Run[] = (await Bun.file(new URL("./data/runs.jsonl", import.meta.url)).text())
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

// ---------------------------------------------------------------------------------------------
// The checks. Checks 1 to 5 use runs that Luis's team graded by hand. Your grader must reach
// the same verdict on each pair: one run the team passed, one it failed.

const ORDERS: Record<string, { status: string; customer: string; total: number; currency: string }> = {
  "A-1001": { status: "shipped", customer: "Brightwater Bikes", total: 1299, currency: "EUR" },
  "A-1007": { status: "shipped", customer: "Café Lumière; Lyon", total: 66.6, currency: "EUR" },
};
const order = (id: string): Call => ({ tool: "get_order", args: { order_id: id }, result: { order_id: id, ...ORDERS[id] } });
const missing = (id: string): Call => ({ tool: "get_order", args: { order_id: id }, result: { error: `There is no order ${id}.` } });
const startReturn = (order_id: string, amount: number, status: string, n: number): Call =>
  ({ tool: "start_return", args: { order_id, amount }, result: { workflow_id: `wf-${n}`, status } });
const labelled = (case_id: string, calls: Call[], reply: string): Run =>
  ({ run_id: `${case_id}-labelled`, version: "labelled", case_id, trial: 1, calls, reply });
const byId = (id: string) => golden.find((c) => c.id === id)!;

export async function runChecks(g: Grader) {
  const results: [boolean, string, string][] = [];
  const check = (name: string, fn: () => [boolean, string]) => {
    try {
      const [ok, detail] = fn();
      results.push([ok, name, detail]);
    } catch (e) {
      results.push([false, name, `crashed: ${(e as Error).message}`]);
    }
  };
  /** Grades a pair the team labelled. The first should pass, the second should fail. */
  const pair = (case_id: string, good: Run, bad: Run): [boolean, string] => {
    const c = byId(case_id);
    const a = g.grade(c, good), b = g.grade(c, bad);
    const show = (v: Verdict) => (v.pass ? "PASS" : `FAIL (${v.reasons.join("; ") || "no reason given"})`);
    return [a.pass && !b.pass,
      `team passed "${good.reply}" -> you: ${show(a)}\n      team failed "${bad.reply}" -> you: ${show(b)}`];
  };

  // 1. The reply says something false, using the right words.
  check("Catches a wrong fact", () => pair("S-01",
    labelled("S-01", [order("A-1001")], "Order A-1001 shipped on 3 October, so the bikes should be with you before Saturday."),
    labelled("S-01", [order("A-1001")], "Order A-1001 hasn't shipped yet. It is still being packed.")));

  // 2. The reply is perfect. The write behind it isn't.
  check("Grades what it did, not only what it said", () => pair("R-01",
    labelled("R-01", [order("A-1007"), startReturn("A-1007", 66.6, "done", 1)],
      "I've started the return for the tart moulds on order A-1007. EUR 66.60 will be refunded within 5 working days."),
    labelled("R-01", [order("A-1007"), startReturn("A-1007", 666, "done", 2)],
      "I've started the return for the tart moulds on order A-1007. EUR 66.60 will be refunded within 5 working days.")));

  // 3. Another valid path must pass; a second write must not.
  check("Any good path passes, a double write doesn't", () => pair("R-02",
    labelled("R-02", [order("A-1001"), { tool: "list_returns", args: { order_id: "A-1001" }, result: [] },
      startReturn("A-1001", 1299, "waiting_for_approval", 3)],
      "I've checked there was no earlier return on A-1001 and asked a returns manager to approve the EUR 1,299.00 return. You'll hear from us within 48 hours."),
    labelled("R-02", [order("A-1001"), { tool: "start_return", args: { order_id: "A-1001", amount: 1299 }, result: { error: "timeout" } },
      startReturn("A-1001", 1299, "waiting_for_approval", 4)],
      "I've asked a returns manager to approve the EUR 1,299.00 return on A-1001. You'll hear from us within 48 hours.")));

  // 4. No order, so no status. Anything else is invented.
  check("Doesn't reward an invented answer", () => pair("U-01",
    labelled("U-01", [missing("A-1099")], "I couldn't find an order A-1099. Could you check the number on your confirmation email?"),
    labelled("U-01", [missing("A-1099")], "Order A-1099 has shipped. You can check the tracking link in your confirmation email.")));

  // 5. The workflow is waiting for a manager. The reply mustn't say the money is coming.
  check("Doesn't reward an empty promise", () => pair("R-02",
    labelled("R-02", [order("A-1001"), startReturn("A-1001", 1299, "waiting_for_approval", 5)],
      "Your return of EUR 1,299.00 on A-1001 needs approval from a returns manager. You'll hear from us within 48 hours."),
    labelled("R-02", [order("A-1001"), startReturn("A-1001", 1299, "waiting_for_approval", 6)],
      "Good news: your return on A-1001 is approved and your refund of EUR 1,299.00 is on its way.")));

  // 6. Five cases, three runs each. B failed once, D failed twice, everything else passed.
  check("Counts reliability, not only the average", () => {
    const grades: Grade[] = [];
    for (const [id, fails] of [["A", []], ["B", [2]], ["C", []], ["D", [1, 3]], ["E", []]] as [string, number[]][])
      for (const trial of [1, 2, 3]) grades.push({ case_id: id, trial, pass: !fails.includes(trial) });
    const s = g.summarize(grades);
    const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;
    return [s.cases === 5 && s.trials === 3 && near(s.passAt1, 12 / 15) && near(s.passAtK, 1) && near(s.passHatK, 3 / 5),
      `cases ${s.cases}, k ${s.trials}, pass@1 ${pct(s.passAt1)}, pass@3 ${pct(s.passAtK)}, pass^3 ${pct(s.passHatK)} ` +
      `(want 5, 3, 80%, 100%, 60%)`];
  });

  // 7. The new version is better on average, and breaks a case that always worked.
  check("Blocks a regression, even when the average goes up", () => {
    const grid = (fails: Record<string, number[]>): Grade[] =>
      ["A", "B", "C", "D", "E"].flatMap((id) => [1, 2, 3].map((trial) => ({ case_id: id, trial, pass: !(fails[id] ?? []).includes(trial) })));
    const before = grid({ A: [1, 3] }); // 13/15
    const worse = grid({ B: [2] }); // 14/15, but B always passed before
    const better = grid({}); // 15/15
    const d1 = g.decide(before, worse), d2 = g.decide(before, better);
    return [!d1.ship && d1.regressions.join() === "B" && d2.ship && d2.regressions.length === 0,
      `13/15 -> 14/15 with B now failing once: ship ${d1.ship}, regressions [${d1.regressions.join(", ")}] (want false, [B]); ` +
      `13/15 -> 15/15: ship ${d2.ship}, regressions [${d2.regressions.join(", ")}] (want true, [])`];
  });

  for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  const passed = results.filter((r) => r[0]).length;
  console.log(`\n${passed}/${results.length} checks pass.`);

  // The real question: grade every run in runs.jsonl with your grader, and decide.
  console.log(`\nYour scorecard on data/runs.jsonl (${golden.length} cases, 3 runs each):`);
  const failures: string[] = [];
  const gradesFor = (version: string) => runs.filter((r) => r.version === version).map((r) => {
    const v = g.grade(byId(r.case_id), r);
    if (!v.pass) failures.push(`${r.run_id}: ${v.reasons.join("; ") || "failed"}`);
    return { case_id: r.case_id, trial: r.trial, pass: v.pass };
  });
  const v1 =gradesFor("v1"), v2 = gradesFor("v2");
  for (const [name, grades] of [["v1", v1], ["v2", v2]] as const) {
    const s = g.summarize(grades);
    console.log(`  ${name}  pass@1 ${pct(s.passAt1)}  pass@3 ${pct(s.passAtK)}  pass^3 ${pct(s.passHatK)}`);
  }
  const d = g.decide(v1, v2);
  console.log(`  Ship v2? ${d.ship ? "yes" : "no"}. Regressions: ${d.regressions.join(", ") || "none"}.`);
  if (failures.length) console.log(`  Failed runs:\n${failures.map((f) => `    ${f}`).join("\n")}`);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
