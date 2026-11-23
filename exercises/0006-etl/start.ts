// Lesson 6 exercise: load two exports that disagree, then reconcile them.
// Run: bun exercises/0006-etl/start.ts
//
// Your job: make every check print PASS. Read the top of harness.ts first: it says what each
// file is supposed to contain. Then open data/orders.csv and data/ledger.csv in a text editor.
import { db, readData, runChecks, type ReportRow } from "./harness.ts";

// The deliberately naive version. It is what most first attempts look like, and it runs
// without a single error. That is the problem.

async function setup() {
  await db.exec(`
    create table orders   (order_id text, ordered_on date, customer text, status text, total double precision, currency text);
    create table invoices (invoice_no text, order_id text, invoiced_on date, customer text, total double precision, currency text);
    create table rejects  (source text, raw text, reason text);
  `);
}

// "Any date parser will do."
function toDate(s: string | undefined): string | null {
  const d = new Date(s ?? "");
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function load() {
  // Every file is UTF-8, right?
  const orders = new TextDecoder().decode(await readData("orders.csv"));
  for (const line of orders.split("\r\n").slice(1)) {
    if (!line.trim()) continue;
    const [orderId, date, customer, status, amount, currency] = line.split(";");
    await db.query("insert into orders values ($1, $2, $3, $4, $5, $6)",
      [orderId, toDate(date), customer, status, parseFloat(amount?.replace(",", ".") ?? ""), currency]);
  }

  const ledger = new TextDecoder().decode(await readData("ledger.csv"));
  for (const line of ledger.split("\r\n").slice(1)) {
    if (!line.trim()) continue;
    const [invoiceNo, orderRef, date, customer, amount, currency] = line.split(",");
    await db.query("insert into invoices values ($1, $2, $3, $4, $5, $6)",
      [invoiceNo, orderRef, toDate(date), customer, parseFloat(amount ?? ""), currency]);
  }
}

async function report(): Promise<ReportRow[]> {
  return (await db.query<ReportRow>(`
    select o.order_id,
           case when o.total = i.total then 'matched' else 'amount_differs' end as verdict,
           o.total as orders_total, i.total as ledger_total
      from orders o
      join invoices i on i.order_id = o.order_id
  `)).rows;
}

// TODO, in the order of the checks:
//   1. Load raw first. Decode each file with its real encoding (new TextDecoder("windows-1252")
//      for the order system), then COPY it into a staging table where every column is text:
//        await db.query("copy orders_raw from '/dev/blob' with (format csv, header match, delimiter ';')",
//                       [], { blob: new Blob([text]) });
//      COPY's CSV mode handles quotes, delimiters inside quotes and line breaks inside quotes.
//      With header match, name the staging columns exactly like the file's header ("OrderId").
//   2. Validate in SQL before you cast: a row whose id, date or amount doesn't match the
//      documented pattern goes into rejects with a reason. Only the rest goes into orders.
//   3. Store money as numeric(12,2), never double precision. Turn 1.299,00 into 1299.00 in SQL.
//   4. Parse dates with the format each source documents: to_date(x, 'DD.MM.YYYY') or 'MM/DD/YYYY'.
//   5. Normalize the hand-typed order refs (trim, upper case, put the hyphen back).
//   6. Make load() safe to run twice: do it in one transaction that replaces what the last
//      load wrote, and give orders a primary key so a duplicate can't slip in.
//   7. Report with a FULL OUTER JOIN, so rows that exist on only one side show up too.
//      Leave cancelled orders out: finance says they never get an invoice.

await runChecks({ setup, load, report });
