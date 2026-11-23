// Shared setup and checks for the Lesson 11 exercise. You don't need to edit this file.
//
// Acme's support agent sends every customer email to a model provider. Acme's data protection
// officer has asked for one change before the next contract year: names, email addresses, phone
// numbers, bank accounts and card numbers stay inside Acme. The model gets placeholders instead,
// and the real values go back in only where a person or a tool needs them.
//
// You write a small masking proxy with four functions (the Proxy type below):
//   mask(conv, text)                      before the email goes to the model
//   unmask(conv, text, actor, purpose)    before a draft reaches Kim, or a tool call reaches a tool
//   exportCase(conv, text)                a copy of the email for the golden set (Lesson 8)
//   setup()                               create your tables
//
// A placeholder looks like [PERSON_1], [EMAIL_1], [PHONE_2], [IBAN_1] or [CARD_1]: the type, an
// underscore, a number. The model has learned to copy them into its drafts unchanged.
//
// This file plays everything around your code:
//   - tickets: which customer account each conversation belongs to (from the helpdesk).
//   - contacts: Acme's CRM. The people at each customer account Acme already knows about.
//   - findNames(text): a stand-in for an NER model. Like a real one, it is good but not perfect.
//   - PRODUCTS: Acme's catalogue. Product names are business data, not personal data.
//   - the model provider. It records exactly what you send it. The checks read that record.
//   - the unmask_log table. You write to it; the checks read it.
//   - a clock you don't control. Use now() from here, never new Date().
import { PGlite } from "@electric-sql/pglite";

export const db = new PGlite();

export type Result = { ok: true; text: string } | { ok: false; error: string };
export type Proxy = {
  setup: () => Promise<void>;
  mask: (conv: string, text: string) => Promise<string>;
  unmask: (conv: string, text: string, actor: string, purpose: string) => Promise<Result>;
  exportCase: (conv: string, text: string) => Promise<string>;
};

export const TYPES = ["PERSON", "EMAIL", "PHONE", "IBAN", "CARD"] as const;
export type PiiType = (typeof TYPES)[number];
/** Finds placeholders like [PERSON_1] or [IBAN_2] in a text. */
export const PLACEHOLDER = /\[(PERSON|EMAIL|PHONE|IBAN|CARD)_\d+\]/g;

export const ACME_DOMAIN = "acme.example"; // Acme's own addresses, e.g. returns@acme.example
export const PRODUCTS = ["Florence 3", "Ridge 2", "Commuter 8"]; // bike models in Acme's catalogue

await db.exec(`
  -- From the helpdesk: which customer account wrote each conversation.
  create table tickets (
    conv       text primary key,
    account    text not null,
    from_email text not null
  );
  insert into tickets values
    ('c-201', 'fietsplaats',    'sanne.visser@fietsplaats.example'),
    ('c-202', 'leidse-fietsen', 'jan@leidsefietsen.example'),
    ('c-203', 'velo-koeln',     'm.schulz@velo-koeln.example');

  -- Acme's CRM: the contacts it knows at each customer account. Read it; never write to it.
  create table contacts (
    account text not null,
    name    text not null,
    email   text,
    phone   text  -- stored in one format: +, country code, digits
  );
  insert into contacts values
    ('fietsplaats',    'Sanne Visser',  'sanne.visser@fietsplaats.example', '+31612345678'),
    ('fietsplaats',    'Pieter Bakker', 'pieter@fietsplaats.example',       null),
    ('leidse-fietsen', 'Jan de Boer',   'jan@leidsefietsen.example',        '+31715550123'),
    ('velo-koeln',     'Markus Schulz', 'm.schulz@velo-koeln.example',      '+4922147110815');

  -- Every call to unmask(), allowed or refused, one row each. You write it.
  -- It records which placeholders were asked for, never the real values behind them.
  create table unmask_log (
    id           serial primary key,
    at           timestamptz not null,  -- now() from this file
    conv         text not null,
    actor        text not null,         -- who asked: a person, or the tool runner
    purpose      text not null,         -- why: 'reply-review', 'tool:start_return', ...
    placeholders text[] not null,       -- the placeholders in the text, e.g. {[IBAN_1],[PERSON_1]}
    outcome      text not null check (outcome in ('unmasked', 'refused')),
    error        text                   -- why it was refused
  );
`);

// ---------------------------------------------------------------------------------------------
// Three emails from the support inbox, in December. Made-up people, made-up numbers.
export const INBOX: Record<string, string> = {
  "c-201": `Hi Acme team,

Where is our order A-1001? We need the bikes for a shop event on Saturday. If anything is wrong, call me on +31 6 1234 5678 or reply to sanne.visser@fietsplaats.example.

If it's easier, pieter from our workshop can pick them up.

Thanks,
Sanne Visser
Fietsplaats Utrecht`,

  "c-202": `Hello,

Two Florence 3 frames on order A-1004 arrived cracked. Photos attached. Please refund EUR 1,299.00 to NL91 ABNA 0417 1643 00 (account holder Jan de Boer).

Regards,
Jan de Boer
Leidse Fietsen · IBAN NL91ABNA0417164300`,

  "c-203": `Guten Tag,

I paid invoice 2026 0000 1234 5678 yesterday with our company card, 4111 1111 1111 1111, but order A-1003 still shows as open. I already wrote to returns@${ACME_DOMAIN} last week. Can you check?

If I'm out, my colleague Lena Hoffmann can answer on 0221 4711 0816. You can also reach me at m.schulz@velo-koeln.example or +49 221 4711 0815.

Markus Schulz
Velo Köln`,
};

// ---------------------------------------------------------------------------------------------
// The clock.
let clock = Date.parse("2026-12-07T09:00:00Z");
export const now = () => new Date(clock);
const advance = (minutes: number) => { clock += minutes * 60_000; };

const io = () => Bun.sleep(2 + Math.random() * 5);

// ---------------------------------------------------------------------------------------------
// The NER stand-in. A real model (spaCy, a transformer, a cloud API) returns spans with a score.
// This one behaves like a real one does on these three emails:
//   - it finds most names, with high scores;
//   - it is unsure about one real name (score 0.58);
//   - it confidently calls the bike model "Florence" a person (score 0.81);
//   - it misses a name written in lower case ("pieter").
export type NameHit = { text: string; start: number; end: number; score: number };
const NER_KNOWS: [string, number][] = [
  ["Sanne Visser", 0.93], ["Jan de Boer", 0.95], ["Markus Schulz", 0.92],
  ["Lena Hoffmann", 0.58], ["Florence", 0.81],
];
export async function findNames(text: string): Promise<NameHit[]> {
  await io();
  const hits: NameHit[] = [];
  for (const [name, score] of NER_KNOWS) {
    for (const m of text.matchAll(new RegExp(`(?<![\\p{L}])${name}(?![\\p{L}])`, "gu"))) {
      hits.push({ text: name, start: m.index!, end: m.index! + name.length, score });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------
// The model provider. A stand-in that drafts a reply from what it was sent, and keeps a copy
// of every request, like a provider's logs do unless your contract says otherwise.
const STATUS: Record<string, string> = {
  "A-1001": "shipped on 28 November",
  "A-1003": "open: the payment arrived and the bikes are being packed",
  "A-1004": "delivered on 2 December",
};
const providerLog = new Map<string, string>();
async function callModel(conv: string, text: string): Promise<string> {
  await io();
  providerLog.set(conv, text);
  const people = text.match(/\[PERSON_\d+\]/g) ?? [];
  const lines = [`Hi ${people.at(-1) ?? "there"},`, ""]; // the sender signs last
  for (const id of new Set(text.match(/A-\d{4}/g) ?? [])) lines.push(`Order ${id} is ${STATUS[id] ?? "not in our system"}.`);
  const iban = text.match(/\[IBAN_\d+\]/)?.[0];
  if (iban) lines.push(`Once the return is approved, we'll refund the account ${iban}.`);
  lines.push("", "Acme Support");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// What counts as a leak. Names are matched as whole words in any letter case; numbers are
// matched with spaces and hyphens removed, so "+31 6 1234 5678" and "+31612345678" both count.
const PERSONAL: Record<string, { words: string[]; numbers: string[]; strings: string[] }> = {
  "c-201": { words: ["sanne", "visser", "pieter"], numbers: ["31612345678"], strings: ["sanne.visser@fietsplaats.example"] },
  "c-202": { words: ["jan", "boer"], numbers: ["NL91ABNA0417164300", "NL91ABNA", "0417164300"], strings: [] },
  "c-203": {
    words: ["markus", "schulz", "lena", "hoffmann"],
    numbers: ["4111111111111111", "4922147110815", "022147110816"],
    strings: ["m.schulz@velo-koeln.example"],
  },
};
function leaks(text: string, convs = Object.keys(PERSONAL)): string[] {
  const lower = text.toLowerCase();
  const compact = text.replace(/[ \-]/g, "").toUpperCase();
  const found: string[] = [];
  for (const c of convs) {
    const p = PERSONAL[c];
    for (const w of p.words) if (new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, "iu").test(text)) found.push(w);
    for (const n of p.numbers) if (compact.includes(n)) found.push(n);
    for (const s of p.strings) if (lower.includes(s)) found.push(s);
  }
  return found;
}

// What the agent needs to do its job. Hiding these breaks the reply.
const KEEP: Record<string, string[]> = {
  "c-201": ["A-1001", "Saturday", "Fietsplaats Utrecht"],
  "c-202": ["A-1004", "Florence 3", "EUR 1,299.00", "Leidse Fietsen"],
  "c-203": ["A-1003", `returns@${ACME_DOMAIN}`, "Velo Köln"],
};
const SENDER: Record<string, string> = { "c-201": "Sanne Visser", "c-202": "Jan de Boer", "c-203": "Markus Schulz" };

// ---------------------------------------------------------------------------------------------
// The checks.

type Call = { conv: string; actor: string; purpose: string; asked: string[]; result: Result | null };

export async function runChecks(proxy: Proxy) {
  const results: [boolean, string, string][] = [];
  const calls: Call[] = [];
  const check = async (name: string, fn: () => Promise<[boolean, string]>) => {
    try {
      const [ok, detail] = await fn();
      results.push([ok, name, detail]);
    } catch (e) {
      results.push([false, name, `crashed: ${(e as Error).message}`]);
    }
  };
  const unmask = async (conv: string, text: string, actor: string, purpose: string) => {
    advance(11);
    const c: Call = { conv, actor, purpose, asked: [...new Set(text.match(PLACEHOLDER) ?? [])].sort(), result: null };
    calls.push(c);
    c.result = await proxy.unmask(conv, text, actor, purpose);
    return c.result;
  };
  const sent = (conv: string) => providerLog.get(conv) ?? "";
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
  const count = (text: string, type: PiiType) => {
    const all = text.match(new RegExp(`\\[${type}_\\d+\\]`, "g")) ?? [];
    return { distinct: new Set(all).size, total: all.length };
  };

  await proxy.setup();

  // The agent's morning: each email is masked, then sent to the model, which drafts a reply.
  const drafts = new Map<string, string>();
  const maskErrors: string[] = [];
  for (const conv of Object.keys(INBOX)) {
    advance(7);
    try {
      drafts.set(conv, await callModel(conv, await proxy.mask(conv, INBOX[conv])));
    } catch (e) {
      maskErrors.push(`${conv}: ${(e as Error).message}`);
    }
  }
  const crashed = maskErrors.length ? `; mask() crashed on ${maskErrors.join("; ")}` : "";

  // 1. Nothing personal leaves Acme: no name, email, phone number, IBAN or card number in any
  //    request to the model provider, in any spelling.
  await check("Nothing personal reaches the model", async () => {
    const found = Object.keys(INBOX).map((c) => [c, leaks(sent(c), [c])] as const);
    const ok = !crashed && found.every(([, f]) => f.length === 0);
    return [ok, `${found.map(([c, f]) => `${c} leaks ${list(f)}`).join("; ")}${crashed} ` +
      `(want none: not "pieter" in lower case, not an IBAN with or without spaces, not a phone number in any format)`];
  });

  // 2. The agent still has what it needs: order numbers, amounts, product names, company names
  //    and Acme's own addresses aren't personal data. Hiding them breaks the reply.
  await check("Keeps what the agent needs", async () => {
    const missing = Object.entries(KEEP).flatMap(([c, keep]) => keep.filter((k) => !sent(c).includes(k)).map((k) => `${c} "${k}"`));
    const ok = !crashed && missing.length === 0;
    return [ok, `hidden or changed: ${list(missing)}${crashed} ` +
      `(want every order number, "Florence 3", "EUR 1,299.00", returns@${ACME_DOMAIN} and the company names unchanged)`];
  });

  // 3. Sixteen digits can be a card number or an invoice number. The card's check digit says which.
  await check("A checksum tells a card from an invoice", async () => {
    const text = sent("c-203");
    const compact = text.replace(/[ \-]/g, "");
    const cardHidden = !compact.includes("4111111111111111");
    const invoiceKept = text.includes("2026 0000 1234 5678");
    const ok = cardHidden && invoiceKept;
    return [ok, `card 4111 1111 1111 1111 ${cardHidden ? "hidden" : "sent"}; invoice 2026 0000 1234 5678 ` +
      `${invoiceKept ? "kept" : "hidden or changed"} (want the card hidden and the invoice kept, digit for digit)`];
  });

  // 4. The model has to know that two mentions are the same person, or the same account.
  //    Jan's name and IBAN each appear twice in c-202, the IBAN once with spaces and once without.
  await check("Same value, same placeholder", async () => {
    const t2 = sent("c-202");
    const iban = count(t2, "IBAN");
    const jan = count(t2, "PERSON");
    const t1 = count(sent("c-201"), "PERSON");
    const t3 = count(sent("c-203"), "PHONE");
    const ok = iban.distinct === 1 && iban.total === 2 && jan.distinct === 1 && jan.total === 2 &&
      t1.distinct === 2 && t3.distinct === 2;
    return [ok, `c-202: ${iban.total} IBAN placeholder(s), ${iban.distinct} distinct; ${jan.total} PERSON, ${jan.distinct} distinct. ` +
      `c-201: ${t1.distinct} distinct PERSON. c-203: ${t3.distinct} distinct PHONE ` +
      `(want c-202: 2 IBAN and 2 PERSON, 1 distinct each; c-201: 2 people, Sanne and Pieter; c-203: 2 phone numbers)`];
  });

  // 5. Unmask only where a person or a tool needs the real value, and only within the same
  //    conversation. A placeholder the vault doesn't know for this conversation is refused.
  await check("Unmasks only its own placeholders", async () => {
    const shown: string[] = [];
    let reviewOk = true;
    for (const conv of Object.keys(INBOX)) {
      const r = await unmask(conv, drafts.get(conv) ?? "", "u-kim", "reply-review");
      const good = r.ok && !r.text.match(PLACEHOLDER) && r.text.includes(SENDER[conv]);
      reviewOk &&= good;
      shown.push(`${conv} ${r.ok ? (good ? "shows the real name" : "unmasked, but wrong") : `refused ("${r.error}")`}`);
    }
    const ibanTok = sent("c-202").match(/\[IBAN_\d+\]/)?.[0];
    let tool: Result = { ok: false, error: "no [IBAN_n] placeholder in what the model saw" };
    let foreign: Result = { ok: false, error: "skipped" };
    if (ibanTok) {
      tool = await unmask("c-202", `{"tool":"start_return","order_id":"A-1004","refund_iban":"${ibanTok}"}`, "svc-tools", "tool:start_return");
      foreign = await unmask("c-201", `We'll refund the account ${ibanTok}.`, "u-kim", "reply-review");
    }
    const madeUp = await unmask("c-203", "Hi [PERSON_99], thanks for writing.", "u-kim", "reply-review");
    const toolOk = tool.ok && tool.text.replace(/[ \-]/g, "").includes("NL91ABNA0417164300");
    const ok = !!ibanTok && reviewOk && toolOk && !foreign.ok && !madeUp.ok;
    const say = (r: Result) => (r.ok ? `unmasked` : `refused`);
    return [ok, `${shown.join("; ")}; start_return gets ${toolOk ? "the real IBAN" : tool.ok ? "no IBAN" : `nothing (${tool.error})`}; ` +
      `c-202's ${ibanTok ?? "IBAN placeholder"} asked for in c-201 -> ${ibanTok ? say(foreign) : "not tried"}; ` +
      `made-up [PERSON_99] -> ${say(madeUp)} (want three real names, the IBAN for the tool, and both of the last two refused)`];
  });

  // 6. Every unmask is logged: who, why, which placeholders, and what happened. Never the values.
  await check("Logs every unmask, never the values", async () => {
    const { rows } = await db.query<{ conv: string; actor: string; purpose: string; placeholders: string[]; outcome: string; error: string | null }>(
      "select conv, actor, purpose, placeholders, outcome, error from unmask_log order by id");
    const bad: string[] = [];
    calls.forEach((c, i) => {
      const row = rows[i];
      if (!row) return void bad.push(`call ${i + 1} (${c.conv}, ${c.purpose}) has no row`);
      const want = c.result?.ok ? "unmasked" : "refused";
      if (row.conv !== c.conv || row.actor !== c.actor || row.purpose !== c.purpose) bad.push(`row ${i + 1} is ${row.conv}/${row.actor}/${row.purpose}, want ${c.conv}/${c.actor}/${c.purpose}`);
      else if (JSON.stringify([...(row.placeholders ?? [])].sort()) !== JSON.stringify(c.asked)) bad.push(`row ${i + 1} lists ${JSON.stringify(row.placeholders)}, want ${JSON.stringify(c.asked)}`);
      else if (row.outcome !== want) bad.push(`row ${i + 1} says ${row.outcome}, want ${want}`);
      else if (want === "refused" && !row.error) bad.push(`row ${i + 1} is refused with no error`);
    });
    const leaked = leaks(JSON.stringify(rows));
    const ok = calls.length > 0 && bad.length === 0 && rows.length === calls.length && leaked.length === 0;
    return [ok, `${rows.length} row(s) for ${calls.length} unmask calls; values in the log: ${list(leaked)}` +
      `${bad.length ? `; ${bad.slice(0, 2).join("; ")}${bad.length > 2 ? `; and ${bad.length - 2} more` : ""}` : ""} ` +
      `(want one row per call, in order, with the placeholders asked for, and no real value anywhere)`];
  });

  // 7. The golden-set copy must be one-way. If its placeholders are the same ones the vault
  //    knows, anyone with the vault can put the names back: that is still personal data.
  await check("The golden-set copy can't be unmasked", async () => {
    const notes: string[] = [];
    let ok = true;
    for (const conv of Object.keys(INBOX)) {
      const copy = await proxy.exportCase(conv, INBOX[conv]);
      const direct = leaks(copy, [conv]);
      const missing = KEEP[conv].filter((k) => !copy.includes(k));
      const back = await proxy.unmask(conv, copy, "u-luis", "export-check");
      const restored = back.ok ? leaks(back.text, [conv]) : [];
      const good = direct.length === 0 && missing.length === 0 && restored.length === 0;
      ok &&= good;
      const problems = [direct.length && `leaks ${list(direct)}`, missing.length && `lost ${list(missing)}`, restored.length && `the vault puts back ${list(restored)}`].filter(Boolean);
      notes.push(`${conv}: ${problems.length ? problems.join(", ") : "one-way"}`);
    }
    return [ok, `${notes.join("; ")} (want each copy free of personal data, with the order details kept, and nothing the vault can put back)`];
  });

  for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  const passed = results.filter((r) => r[0]).length;
  console.log(`\n${passed}/${results.length} checks pass.`);

  // What each side sees for c-202.
  console.log("\nc-202, as the model provider saw it:");
  console.log(sent("c-202").split("\n").map((l) => `  | ${l}`).join("\n"));
  try {
    const r = await proxy.unmask("c-202", drafts.get("c-202") ?? "", "u-kim", "reply-review");
    console.log("\nThe draft, as Kim sees it in the review queue:");
    console.log((r.ok ? r.text : `(refused: ${r.error})`).split("\n").map((l) => `  | ${l}`).join("\n"));
    const { rows } = await db.query<{ n: number; refused: number }>(
      "select count(*)::int as n, count(*) filter (where outcome = 'refused')::int as refused from unmask_log");
    console.log(`\nUnmask log: ${rows[0].n} calls, ${rows[0].refused} refused.`);
  } catch (e) {
    console.log(`  (couldn't unmask or read the log: ${(e as Error).message})`);
  }
  await db.close(); // without this, PGlite can keep the process alive for several seconds
}
