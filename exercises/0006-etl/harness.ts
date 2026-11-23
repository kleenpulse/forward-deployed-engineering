// Shared setup and checks for the Lesson 6 exercise. You don't need to edit this file.
//
// Acme's finance team says October doesn't add up. You got two exports of the same orders:
//   data/orders.csv  from the order system (OrderService, 2009): its "Export to CSV" button.
//   data/ledger.csv  from the accounting system: an Excel report, saved as CSV.
// Open both in a text editor before you start (not in Excel: it would "fix" them for you).
//
// What the order system's manual says about its export:
//   - one row per order; columns OrderId, OrderDate, CustNm, StatusCd, TotAmt, CurrCd, Notes;
//   - separated by semicolons; text encoded as Windows-1252; dates as DD.MM.YYYY;
//   - amounts with a decimal comma and a dot every three digits: 1.299,00 means 1299.00;
//   - status codes: OPEN, BCKORD (backordered), SHPD (shipped), CNCL (cancelled).
// What finance told you about the ledger:
//   - one row per invoice; "Order Ref" is typed in by hand, so its format varies;
//   - dates are US style, MM/DD/YYYY; amounts like 1,299.00;
//   - every order that isn't cancelled should have an invoice for the same amount.
//
// Your pipeline creates three tables, with these names and at least these columns:
//   orders   (order_id, ordered_on, customer, status, total, currency)    one row per order
//   invoices (invoice_no, order_id, invoiced_on, customer, total, currency) one row per invoice
//   rejects  (source, raw, reason)   every input row you didn't load, and why
// and a report: one row per order id that needs a verdict.
import { PGlite } from "@electric-sql/pglite";

export const db = new PGlite();

/** The raw bytes of a file in data/. Decoding them is your job. */
export async function readData(name: "orders.csv" | "ledger.csv"): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(new URL(`./data/${name}`, import.meta.url)).arrayBuffer());
}

export type Verdict = "matched" | "amount_differs" | "only_in_orders" | "only_in_ledger";
export type ReportRow = { order_id: string; verdict: Verdict; orders_total: unknown; ledger_total: unknown };
export type Pipeline = {
  setup: () => Promise<void>; // create tables, once
  load: () => Promise<void>; // read both files and (re)load the tables; may run more than once
  report: () => Promise<ReportRow[]>;
};

// ---------------------------------------------------------------------------------------------
// What a careful person finds by hand. The checks compare your tables with this.

const ORDER_IDS = ["A-1001", "A-1002", "A-1003", "A-1004", "A-1005", "A-1006", "A-1007", "A-1008", "A-1009", "A-1012"];
const INVOICE_ORDER_IDS = ["A-1001", "A-1002", "A-1003", "A-1004", "A-1006", "A-1007", "A-1008", "A-1011", "A-1012"];
const EXPECTED: Record<string, Verdict> = {
  "A-1001": "matched", "A-1002": "matched", "A-1003": "matched", "A-1004": "amount_differs",
  "A-1006": "matched", "A-1007": "matched", "A-1008": "matched", "A-1009": "only_in_orders",
  "A-1011": "only_in_ledger", "A-1012": "matched",
};

async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(text, params)).rows;
}
async function tryQ<T = any>(text: string, params: unknown[] = []): Promise<T[] | string> {
  try {
    return await q<T>(text, params);
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}
const show = (v: unknown) => (v === undefined ? "missing" : JSON.stringify(v));
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const typeOf = async (table: string, column: string) =>
  (await q<{ data_type: string }>(
    "select data_type from information_schema.columns where table_name = $1 and column_name = $2", [table, column],
  ))[0]?.data_type ?? "missing";

async function counts() {
  const one = async (t: string) => {
    const r = await tryQ<{ n: number }>(`select count(*)::int as n from ${t}`);
    return typeof r === "string" ? -1 : r[0].n;
  };
  return { orders: await one("orders"), invoices: await one("invoices"), rejects: await one("rejects") };
}

export async function runChecks(p: Pipeline) {
  const results: [boolean, string, string][] = [];
  const check = async (name: string, fn: () => Promise<[boolean, string]>) => {
    try {
      const [ok, detail] = await fn();
      results.push([ok, name, detail]);
    } catch (e) {
      results.push([false, name, `crashed: ${(e as Error).message}`]);
    }
  };

  await p.setup();
  let loadError = "";
  try {
    await p.load();
  } catch (e) {
    loadError = (e as Error).message;
  }
  const first = await counts();
  let report: ReportRow[] | string;
  try {
    report = await p.report();
  } catch (e) {
    report = `error: ${(e as Error).message}`;
  }

  // 1. Every input row is either loaded or rejected with a reason. Nothing vanishes, nothing is invented.
  await check("Every row is loaded or rejected", async () => {
    const ids = (await q<{ order_id: string }>("select order_id from orders")).map((r) => r.order_id);
    const rejects = await q<{ raw: string; reason: string }>("select raw::text as raw, reason::text as reason from rejects");
    const bad = ids.filter((id) => !/^A-\d{4}$/.test(id ?? ""));
    const a1010 = rejects.find((r) => r.raw?.includes("A-1010"));
    const missing = ORDER_IDS.filter((id) => !ids.includes(id));
    const ok = !loadError && bad.length === 0 && missing.length === 0 && !ids.includes("A-1010") && !!a1010?.reason?.trim();
    return [ok, [
      loadError ? `load() threw: ${loadError}` : "",
      `orders has ${new Set(ids).size} distinct order ids (want ${ORDER_IDS.length})`,
      missing.length ? `missing: ${missing.join(", ")}` : "",
      bad.length ? `not order ids: ${bad.slice(0, 3).map(show).join(", ")}` : "",
      ids.includes("A-1010") ? "A-1010 was loaded, but its amount is \"n/a\"" : "",
      a1010 ? `A-1010 rejected: ${show(a1010.reason)}` : "A-1010 not in rejects (want it rejected, with a reason)",
    ].filter(Boolean).join("; ")];
  });

  // 2. Names with accents and with the delimiter inside them arrive intact, in both files.
  await check("Text survives the trip", async () => {
    const want: [string, string, string][] = [
      ["orders", "A-1006", "Müller Werkzeuge GmbH"],
      ["orders", "A-1007", "Café Lumière; Lyon"],
      ["orders", "A-1008", "Søndergaard Design"],
      ["invoices", "A-1006", "Müller Werkzeuge GmbH"],
    ];
    const lines: string[] = [];
    let ok = true;
    for (const [t, id, name] of want) {
      const got = (await q<{ customer: string }>(`select customer from ${t} where order_id = $1`, [id]))[0]?.customer;
      if (got !== name) ok = false;
      lines.push(`${t} ${id}: ${show(got)}${got === name ? "" : ` (want ${show(name)})`}`);
    }
    return [ok, lines.join("; ")];
  });

  // 3. Money is stored as exact decimals, and the totals per currency are right to the cent.
  await check("Money is exact", async () => {
    const types = [await typeOf("orders", "total"), await typeOf("invoices", "total")];
    const sums = async (t: string) =>
      Object.fromEntries((await q<{ currency: string; s: string }>(
        `select currency, sum(total)::numeric(14,2)::text as s from ${t} group by currency order by currency`,
      )).map((r) => [r.currency, r.s]));
    const o = await sums("orders");
    const i = await sums("invoices");
    const ok = types.every((t) => t === "numeric") &&
      o.EUR === "8466.10" && o.GBP === "235.19" && i.EUR === "8309.50" && i.GBP === "79.99";
    return [ok, `total types: ${types.join(", ")} (want numeric); orders ${show(o)} (want EUR 8466.10, GBP 235.19); invoices ${show(i)} (want EUR 8309.50, GBP 79.99)`];
  });

  // 4. Dates mean the same day they meant in the source.
  await check("Dates mean the same day", async () => {
    const types = [await typeOf("orders", "ordered_on"), await typeOf("invoices", "invoiced_on")];
    const day = async (sql: string, id: string) => {
      const rows = await q<{ d: string | null }>(sql, [id]);
      return rows.length === 0 ? "no row" : rows[0].d ?? "empty";
    };
    const got = {
      "A-1002 ordered": await day("select ordered_on::text as d from orders where order_id = $1", "A-1002"),
      "A-1008 ordered": await day("select ordered_on::text as d from orders where order_id = $1", "A-1008"),
      "A-1002 invoiced": await day("select invoiced_on::text as d from invoices where order_id = $1", "A-1002"),
      "A-1007 invoiced": await day("select invoiced_on::text as d from invoices where order_id = $1", "A-1007"),
    };
    const want = { "A-1002 ordered": "2026-10-03", "A-1008 ordered": "2026-10-14", "A-1002 invoiced": "2026-10-03", "A-1007 invoiced": "2026-10-12" };
    const ok = types.every((t) => t === "date") && Object.entries(want).every(([k, v]) => got[k as keyof typeof got] === v);
    return [ok, `types: ${types.join(", ")} (want date); ` +
      Object.entries(want).map(([k, v]) => `${k} ${got[k as keyof typeof got]}${got[k as keyof typeof got] === v ? "" : ` (want ${v})`}`).join("; ")];
  });

  // 5. Hand-typed references are normalized, so invoices point at real order ids.
  await check("Keys line up", async () => {
    const ids = (await q<{ order_id: string }>("select order_id from invoices order by order_id")).map((r) => r.order_id);
    const odd = ids.filter((id) => !INVOICE_ORDER_IDS.includes(id));
    return [sameSet(ids, INVOICE_ORDER_IDS),
      `invoices point at ${ids.length} order ids${odd.length ? `; unrecognised: ${odd.map(show).join(", ")}` : ", all in the A-1001 format"} (want ${INVOICE_ORDER_IDS.length}: ${INVOICE_ORDER_IDS.join(" ")})`];
  });

  // 6. Running the load again gives the same tables: no duplicates, nothing doubled.
  await check("Loading twice changes nothing", async () => {
    let again = "";
    try {
      await p.load();
    } catch (e) {
      again = (e as Error).message;
    }
    const second = await counts();
    const dupes = await q<{ order_id: string; n: number }>(
      "select order_id, count(*)::int as n from orders group by order_id having count(*) > 1 order by n desc, order_id");
    const ok = !again && JSON.stringify(first) === JSON.stringify(second) && dupes.length === 0;
    return [ok, [
      again ? `second load() threw: ${again}` : "",
      `rows after 1st load ${show(first)}, after 2nd ${show(second)}`,
      dupes.length
        ? `duplicate order ids: ${dupes.slice(0, 4).map((d) => `${d.order_id} x${d.n}`).join(", ")}${dupes.length > 4 ? ` and ${dupes.length - 4} more` : ""}`
        : "no duplicate order ids",
    ].filter(Boolean).join("; ")];
  });

  // 7. The report finds exactly the real differences, and nothing else.
  await check("The report finds the real differences", async () => {
    if (typeof report === "string") return [false, `report() ${report}`];
    const got: Record<string, ReportRow> = Object.fromEntries(report.map((r) => [r.order_id, r]));
    const wrong = Object.entries(EXPECTED).filter(([id, v]) => got[id]?.verdict !== v)
      .map(([id, v]) => `${id} ${got[id]?.verdict ?? "missing"} (want ${v})`);
    const extra = Object.keys(got).filter((id) => !(id in EXPECTED)).map((id) => `${id} ${got[id].verdict} (want no row)`);
    const r4 = got["A-1004"];
    const amounts = r4 && Number(r4.orders_total) === 3150 && Number(r4.ledger_total) === 3105;
    const findings = Object.entries(EXPECTED).filter(([, v]) => v !== "matched").map(([id, v]) => `${id} ${v}`).join(", ");
    return [wrong.length === 0 && extra.length === 0 && !!amounts,
      wrong.length || extra.length || !amounts
        ? [...wrong, ...extra, amounts ? "" : `A-1004 totals ${show(r4?.orders_total)} vs ${show(r4?.ledger_total)} (want 3150.00 vs 3105.00)`].filter(Boolean).slice(0, 5).join("; ")
        : `${findings}; A-1004 is 3150.00 in orders and 3105.00 in the ledger; everything else matches`];
  });

  for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  const passed = results.filter((r) => r[0]).length;
  console.log(`\n${passed}/${results.length} checks pass.`);
  await db.close(); // without this, PGlite can keep the process alive for several seconds
}
