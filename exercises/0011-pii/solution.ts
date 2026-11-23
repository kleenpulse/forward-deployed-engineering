// Lesson 11 exercise: worked solution. Try start.ts first.
// Run: bun exercises/0011-pii/solution.ts
import { ACME_DOMAIN, db, findNames, now, PLACEHOLDER, PRODUCTS, runChecks, type PiiType, type Result } from "./harness.ts";

type Span = { start: number; end: number; type: PiiType; value: string }; // value: normalised

async function setup() {
  // The vault. Whoever can read this table can undo the masking, so in production it is
  // encrypted, kept where the customer's data may live, and deleted when no longer needed.
  await db.exec(`
    create table vault (
      conv        text not null,
      placeholder text not null,
      type        text not null,
      value       text not null,
      primary key (conv, placeholder),
      unique (conv, type, value)
    );
  `);
}

// ---------------------------------------------------------------------------------------------
// Detection: three detectors, then one rule for overlaps.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(s)}(?![\\p{L}\\p{N}])`, "giu");

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4); // country and check digits go to the end
  const digits = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55)); // A=10 … Z=35
  return BigInt(digits) % 97n === 1n;
}

async function detect(conv: string, text: string): Promise<Span[]> {
  const spans: Span[] = [];

  // 1. What Acme already knows: the contacts at this ticket's account. The most reliable
  //    detector there is, and the only one here that finds "pieter".
  const { rows: contacts } = await db.query<{ name: string }>(
    "select c.name from contacts c join tickets t on t.account = c.account where t.conv = $1", [conv]);
  for (const { name } of contacts) {
    for (const form of [name, name.split(" ")[0]]) {
      for (const m of text.matchAll(word(form))) spans.push({ start: m.index!, end: m.index! + m[0].length, type: "PERSON", value: name });
    }
  }

  // 2. Patterns, checked. Email addresses (except Acme's own), IBANs that pass mod 97, and every
  //    run of digits classified once, as a whole.
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)) {
    if (m[0].toLowerCase().endsWith(`@${ACME_DOMAIN}`)) continue;
    spans.push({ start: m.index!, end: m.index! + m[0].length, type: "EMAIL", value: m[0].toLowerCase() });
  }
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g)) {
    const iban = m[0].replace(/ /g, "");
    if (ibanValid(iban)) spans.push({ start: m.index!, end: m.index! + m[0].length, type: "IBAN", value: iban });
  }
  for (const m of text.matchAll(/\+?\d(?:[ -]?\d)*/g)) {
    const digits = m[0].replace(/\D/g, "");
    const type: PiiType | null =
      m[0].startsWith("+") ? "PHONE" :
      digits.length >= 13 && digits.length <= 19 && luhn(digits) ? "CARD" :
      m[0].startsWith("0") && digits.length >= 8 ? "PHONE" :
      null; // order numbers, invoice numbers, amounts, years: keep
    if (type) spans.push({ start: m.index!, end: m.index! + m[0].length, type, value: (m[0].startsWith("+") ? "+" : "") + digits });
  }

  // 3. The NER model, for people Acme doesn't know. Every hit counts, whatever its score:
  //    Lena scores 0.58 and is real. Hits inside a product name are business data, not people.
  const products = PRODUCTS.flatMap((p) => [...text.matchAll(word(p))].map((m) => [m.index!, m.index! + p.length]));
  for (const hit of await findNames(text)) {
    if (products.some(([s, e]) => hit.start < e && hit.end > s)) continue;
    const known = contacts.find((c) => c.name.toLowerCase() === hit.text.toLowerCase());
    spans.push({ start: hit.start, end: hit.end, type: "PERSON", value: known?.name ?? hit.text });
  }

  // Overlaps: the span that starts first wins, then the longer one. So the email address beats
  // the "Sanne" inside it, and the IBAN beats the run of digits inside it.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  for (const s of spans) if (!kept.length || s.start >= kept[kept.length - 1].end) kept.push(s);
  return kept;
}

function replaceSpans(text: string, spans: Span[], by: (s: Span) => string): string {
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + by(s);
    at = s.end;
  }
  return out + text.slice(at);
}

// ---------------------------------------------------------------------------------------------
// The proxy.

async function mask(conv: string, text: string): Promise<string> {
  const spans = await detect(conv, text);
  const placeholders: string[] = [];
  for (const s of spans) {
    // Same value, same placeholder: look it up first, number a new one per conversation.
    const { rows } = await db.query<{ placeholder: string }>(
      "select placeholder from vault where conv = $1 and type = $2 and value = $3", [conv, s.type, s.value]);
    let p = rows[0]?.placeholder;
    if (!p) {
      const { rows: [{ n }] } = await db.query<{ n: number }>(
        "select count(*)::int as n from vault where conv = $1 and type = $2", [conv, s.type]);
      p = `[${s.type}_${n + 1}]`;
      await db.query("insert into vault values ($1, $2, $3, $4)", [conv, p, s.type, s.value]);
    }
    placeholders.push(p);
  }
  let i = 0;
  return replaceSpans(text, spans, () => placeholders[i++]);
}

async function unmask(conv: string, text: string, actor: string, purpose: string): Promise<Result> {
  const asked = [...new Set(text.match(PLACEHOLDER) ?? [])].sort();
  const { rows } = await db.query<{ placeholder: string; value: string }>(
    "select placeholder, value from vault where conv = $1 and placeholder = any($2)", [conv, asked]);
  const found = new Map(rows.map((r) => [r.placeholder, r.value]));
  const unknown = asked.filter((p) => !found.has(p));
  const error = unknown.length
    ? `${unknown.join(", ")} ${unknown.length === 1 ? "isn't" : "aren't"} in conversation ${conv}. Nothing was unmasked.`
    : null;
  await db.query(
    "insert into unmask_log (at, conv, actor, purpose, placeholders, outcome, error) values ($1, $2, $3, $4, $5, $6, $7)",
    [now().toISOString(), conv, actor, purpose, asked, error ? "refused" : "unmasked", error]);
  return error ? { ok: false, error } : { ok: true, text: text.replace(PLACEHOLDER, (p) => found.get(p)!) };
}

// One-way: the same detection, a label with no number, and nothing stored.
async function exportCase(conv: string, text: string): Promise<string> {
  return replaceSpans(text, await detect(conv, text), (s) => `[${s.type}]`);
}

await runChecks({ setup, mask, unmask, exportCase });
