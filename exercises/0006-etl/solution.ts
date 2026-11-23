// Lesson 6 exercise: worked solution.
// Run: bun exercises/0006-etl/solution.ts
//
// The shape: land each file as raw text, validate and convert in SQL, keep every rejected
// row with a reason, then reconcile with a full outer join.
import { db, readData, runChecks, type ReportRow } from "./harness.ts";

async function setup() {
  await db.exec(`
    -- Staging: every column is text, named exactly like the file's header, so that
    -- COPY ... HEADER MATCH fails loudly if a future export moves or renames a column.
    create table orders_raw ("OrderId" text, "OrderDate" text, "CustNm" text, "StatusCd" text,
                             "TotAmt" text, "CurrCd" text, "Notes" text);
    create table ledger_raw ("Invoice No" text, "Order Ref" text, "Invoice Date" text,
                             "Customer" text, "Net Amount" text, "Currency" text);

    -- Clean tables: real types, and keys that make a duplicate impossible.
    create table orders (
      order_id   text primary key,
      ordered_on date not null,
      customer   text not null,
      status     text not null,
      total      numeric(12,2) not null,
      currency   text not null
    );
    create table invoices (
      invoice_no  text primary key,
      order_id    text not null,
      invoiced_on date not null,
      customer    text not null,
      total       numeric(12,2) not null,
      currency    text not null
    );
    create table rejects (source text not null, raw text not null, reason text not null);

    -- One reason per bad row, or null when the row is fine. Validate the text against the
    -- documented format BEFORE casting, so one bad value can't stop the whole load.
    create view orders_checked as
      select r.*, case
          when "OrderId" is null or "OrderId" !~ '^A-[0-9]{4}$' then 'OrderId is not like A-1001'
          when "OrderDate" !~ '^[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}$' then 'OrderDate is not DD.MM.YYYY'
          when "TotAmt" !~ '^[0-9]{1,3}(\\.[0-9]{3})*,[0-9]{2}$' then 'TotAmt is not an amount like 1.299,00'
          when "CurrCd" not in ('EUR', 'GBP') then 'unknown currency'
          when "StatusCd" not in ('OPEN', 'BCKORD', 'SHPD', 'CNCL') then 'unknown status code'
        end as reason
      from orders_raw r;

    create view ledger_checked as
      select r.*,
        -- "a-1002 " and "A1003" are the same ids typed by hand.
        upper(regexp_replace(trim("Order Ref"), '^([A-Za-z])-?([0-9]{4})$', '\\1-\\2')) as order_id,
        case
          when upper(regexp_replace(trim("Order Ref"), '^([A-Za-z])-?([0-9]{4})$', '\\1-\\2')) !~ '^A-[0-9]{4}$'
            then 'Order Ref is not an order id'
          when "Invoice Date" !~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' then 'Invoice Date is not MM/DD/YYYY'
          when "Net Amount" !~ '^[0-9]{1,3}(,[0-9]{3})*\\.[0-9]{2}$' then 'Net Amount is not an amount like 1,299.00'
          when "Currency" not in ('EUR', 'GBP') then 'unknown currency'
        end as reason
      from ledger_raw r;
  `);
}

async function load() {
  // Decode each file with the encoding its source really uses. The UTF-8 decoder also
  // drops the ledger's byte order mark, which would otherwise end up in the first header.
  const orders = new TextDecoder("windows-1252").decode(await readData("orders.csv"));
  const ledger = new TextDecoder("utf-8").decode(await readData("ledger.csv"));

  // One transaction: a reader sees the old load or the new one, never half of each.
  // Replacing everything makes the load safe to repeat: run it twice, get the same tables.
  await db.transaction(async (tx) => {
    await tx.exec("truncate orders_raw, ledger_raw, orders, invoices, rejects");
    await tx.query("copy orders_raw from '/dev/blob' with (format csv, header match, delimiter ';')",
      [], { blob: new Blob([orders]) });
    await tx.query("copy ledger_raw from '/dev/blob' with (format csv, header match)",
      [], { blob: new Blob([ledger]) });

    await tx.exec(`
      insert into rejects (source, raw, reason)
        select 'orders.csv', row_to_json(c)::text, reason from orders_checked c where reason is not null
        union all
        select 'ledger.csv', row_to_json(c)::text, reason from ledger_checked c where reason is not null;

      -- distinct folds rows that are exact copies. Two different rows with the same id would
      -- still hit the primary key and fail the load, which is what you want: ask, don't guess.
      insert into orders (order_id, ordered_on, customer, status, total, currency)
        select distinct
               "OrderId",
               to_date("OrderDate", 'DD.MM.YYYY'),
               "CustNm",
               case "StatusCd" when 'OPEN' then 'open' when 'BCKORD' then 'backordered'
                               when 'SHPD' then 'shipped' when 'CNCL' then 'cancelled' end,
               replace(replace("TotAmt", '.', ''), ',', '.')::numeric(12,2),
               "CurrCd"
          from orders_checked where reason is null;

      insert into invoices (invoice_no, order_id, invoiced_on, customer, total, currency)
        select "Invoice No", order_id, to_date("Invoice Date", 'MM/DD/YYYY'), "Customer",
               replace("Net Amount", ',', '')::numeric(12,2), "Currency"
          from ledger_checked where reason is null;
    `);
  });
}

async function report(): Promise<ReportRow[]> {
  return (await db.query<ReportRow>(`
    with o as (
      -- Finance: cancelled orders never get an invoice, so they have nothing to match.
      select order_id, total, currency from orders where status <> 'cancelled'
    ), i as (
      -- Compare at the grain both sides share: one row per order, even if it has two invoices.
      select order_id, sum(total) as total, min(currency) as currency, count(distinct currency) as currencies
        from invoices group by order_id
    )
    select coalesce(o.order_id, i.order_id) as order_id,
           case when o.order_id is null then 'only_in_ledger'
                when i.order_id is null then 'only_in_orders'
                when o.total = i.total and o.currency = i.currency and i.currencies = 1 then 'matched'
                else 'amount_differs' end as verdict,
           o.total as orders_total,
           i.total as ledger_total
      from o full outer join i on i.order_id = o.order_id
     order by 1
  `)).rows;
}

await runChecks({ setup, load, report });
