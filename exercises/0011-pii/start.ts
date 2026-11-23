// Lesson 11 exercise: a masking proxy between Acme's support agent and the model provider.
// Run: bun exercises/0011-pii/start.ts
//
// Your job: make every check print PASS. Read the top of harness.ts first: it describes the
// placeholders, the tickets and contacts tables, the NER stand-in and the unmask_log table.
import { findNames, runChecks, type Result } from "./harness.ts";

// The deliberately naive version: two regular expressions, the NER model's names, and a map in
// memory. It's what most first attempts look like, and on a demo email it seems to work.

const vault = new Map<string, string>(); // placeholder -> real value
let n = 0;
const hide = (type: string, value: string) => {
  const placeholder = `[${type}_${++n}]`;
  vault.set(placeholder, value);
  return placeholder;
};

async function setup() {}

async function mask(conv: string, text: string): Promise<string> {
  let out = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, (m) => hide("EMAIL", m)); // email addresses
  out = out.replace(/\+?\d[\d -]{7,}\d/g, (m) => hide("PHONE", m)); // "anything that looks like a phone number"
  for (const hit of await findNames(out)) out = out.replaceAll(hit.text, hide("PERSON", hit.text));
  return out;
}

async function unmask(conv: string, text: string, actor: string, purpose: string): Promise<Result> {
  return { ok: true, text: text.replace(/\[[A-Z]+_\d+\]/g, (p) => vault.get(p) ?? p) };
}

// "The golden set gets the masked text, so it has no names in it."
async function exportCase(conv: string, text: string): Promise<string> {
  return mask(conv, text);
}

// TODO, in the order of the checks:
//   1. Find every name, email address, phone number, IBAN and card number, in any spelling.
//      Three detectors, each good at something: the CRM (contacts of this ticket's account, full
//      name and first name, any letter case), patterns with a checksum, and findNames() for
//      people Acme doesn't know. Use all of findNames()'s hits: no score threshold is safe here.
//   2. Don't hide what the agent needs: drop name hits that sit inside a PRODUCTS name, and
//      leave addresses at ACME_DOMAIN alone.
//   3. Classify each whole run of digits once. 13 to 19 digits that pass the Luhn check: CARD.
//      Starts with + or 0: PHONE. Anything else (order numbers, invoices, amounts): keep it.
//      An IBAN is 2 letters, 2 check digits, then letters and digits; check it with mod 97.
//      When two hits overlap, keep the one that starts first, then the longer one.
//   4. Same value, same placeholder within a conversation. Normalise before you compare:
//      no spaces in an IBAN, emails in lower case, a contact's first name maps to their full name.
//      Number the placeholders per conversation, and keep them in a table (setup() creates it).
//   5. unmask() looks placeholders up in THIS conversation only. If any placeholder in the text
//      is unknown there, refuse the whole call with { ok: false, error }. Never throw.
//   6. Write one unmask_log row for every unmask() call: conv, actor, purpose, the placeholders
//      asked for, the outcome, and the error if refused. Never the real values.
//   7. exportCase() hides the same things, but one-way: use [PERSON], [EMAIL] and so on, with
//      no number, and store nothing. The vault must not be able to put anything back.

await runChecks({ setup, mask, unmask, exportCase });
