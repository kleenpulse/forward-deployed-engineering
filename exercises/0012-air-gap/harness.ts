// Shared setup and checks for the Lesson 12 exercise. You don't need to edit this file.
//
// Torvik builds sonar parts for navies. The agent runs on Torvik's "high side": a network with no
// route to the internet. Nothing gets in by download. Every release crosses the gap as a bundle
// on approved media: the vendor builds and signs it, Ingrid, Torvik's security officer, scans it
// and carries it across, and on the high side one function decides whether it gets installed.
// You write that function: importBundle(dir).
//
// A bundle is a folder (look at them: they're written to exercises/0012-air-gap/media/ on every run):
//   manifest.json     { name, version, created, files: [{ path, sha256, bytes }] }
//   manifest.sig      an Ed25519 signature over the exact bytes of manifest.json, in base64
//   signing-key.pub   the public key that made the signature, "for convenience". Proves nothing.
//   config.json       the agent's settings: every URL in it is a place the agent will connect to
//   image/agent.tar   the agent's container image (a stand-in)
//   model/weights.bin the model's weights (a stand-in)
//   migrations/*.sql  every database migration so far, 0001 to the newest. Apply only the new ones.
//
// What the high side already has (created below):
//   - PINNED_KEY: the vendor's release key, installed when Torvik accredited the system. Ingrid's
//     team checked its fingerprint with the vendor in person. It's the only key that counts.
//   - INSIDE: Torvik's internal domain. Hosts under it are reachable. Nothing else is.
//   - deployment: the one row saying which version runs now (1.9.2 at the start).
//   - schema_migrations: the migrations applied so far (0001 to 0003).
//   - import_log: one row per import attempt, for Torvik's accreditor. You write it; checks read it.
//   - fetch(): there is no network. Every call is recorded (on the high side, every blocked
//     connection is an alert for the security team) and fails.
//   - a clock: use now() from here, never new Date().
import { PGlite } from "@electric-sql/pglite";
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const db = new PGlite();
export const MEDIA = join(import.meta.dir, "media");
export const INSIDE = "torvik.internal";

export type Result = { ok: true; version: string } | { ok: false; error: string };
export type Importer = { importBundle: (dir: string) => Promise<Result> };
export type Manifest = { name: string; version: string; created: string; files: { path: string; sha256: string; bytes: number }[] };

// ---------------------------------------------------------------------------------------------
// Helpers you can use.

/** SHA-256 of some bytes, as lower-case hex. */
export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** True only if `signatureB64` is a valid Ed25519 signature by `publicKeyPem` over exactly `data`. */
export function verifySignature(publicKeyPem: string, data: Uint8Array, signatureB64: string): boolean {
  try {
    return verify(null, data, createPublicKey(publicKeyPem), Buffer.from(signatureB64.trim(), "base64"));
  } catch {
    return false;
  }
}

/** Every file under dir, as paths relative to dir with forward slashes, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).replaceAll("\\", "/"));
    }
  };
  walk(dir);
  return out.sort();
}

// ---------------------------------------------------------------------------------------------
// The clock.
let clock = Date.parse("2026-12-01T08:00:00Z");
export const now = () => new Date(clock);

// ---------------------------------------------------------------------------------------------
// No network. Every attempt is recorded, then fails.
export const outbound: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  outbound.push(input instanceof Request ? input.url : String(input));
  throw new TypeError("fetch failed: no route out of the high side");
}) as typeof fetch;

// ---------------------------------------------------------------------------------------------
// The vendor's side: keys and bundles. On the high side you only ever see the public key.
const vendor = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519"); // not the vendor's release key
const pem = (k: KeyObject) => k.export({ type: "spki", format: "pem" }).toString();
export const PINNED_KEY = pem(vendor.publicKey);

// Deterministic stand-in bytes, so the manifests (and their hashes) are the same on every run.
function bytes(seed: string, n: number): Uint8Array {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    out[i] = h & 0xff;
  }
  return out;
}
const text = (s: string) => new TextEncoder().encode(s);

const MIGRATIONS: Record<string, string> = {
  "0001_requests.sql": "create table requests (id text primary key, sender text not null, body text not null, received_at timestamptz not null);\n",
  "0002_drafts.sql": "create table drafts (id serial primary key, request_id text not null references requests (id), body text not null, status text not null default 'review');\n",
  "0003_approvals.sql": "alter table drafts add column approved_by text;\n",
  "0004_model_version.sql": "alter table drafts add column model_version text;\n",
  "0005_tool_calls.sql": "create table tool_calls (id serial primary key, draft_id int not null references drafts (id), tool text not null, args jsonb not null);\n",
  "0006_tool_calls_index.sql": "create index tool_calls_by_draft on tool_calls (draft_id);\n",
};
const BROKEN_0006 = "create index tool_calls_by_draft on tool_calls (draft);\n"; // there is no column "draft"

const CONFIG = {
  model_endpoint: "http://llm.torvik.internal:8000/v1",
  model: "local-70b-instruct",
  crm_url: "https://crm.torvik.internal/api",
  telemetry_endpoint: "http://otel.torvik.internal:4318",
  docs_url: "https://torvik.internal/wiki/support-agent",
  approval_limit_eur: 500,
};
// 1.11.0 as first built: the vendor's defaults were left in.
const CONFIG_PHONES_HOME = {
  ...CONFIG,
  telemetry_endpoint: "https://otel.vendor.example/v1/traces",
  crash_reports: { enabled: true, url: "https://crashes.vendor.example/tenants/torvik.internal/report" },
};

type Spec = {
  media: string; // the folder name: order, date, what Ingrid wrote on the label
  date: string;
  version: string;
  migrations: string[];
  config?: object;
  signer?: "vendor" | "stranger"; // who signs. Default: the vendor
  image?: string; // seed for the image bytes
  broken0006?: boolean;
  after?: (dir: string) => void; // what happened to the media after signing
};

const upTo = (n: number) => Object.keys(MIGRATIONS).slice(0, n);
const MEDIA_LIST: Spec[] = [
  { media: "01-agent-1.10.0", date: "2026-12-02", version: "1.10.0", migrations: upTo(4) },
  { media: "02-agent-1.10.1", date: "2026-12-04", version: "1.10.1", migrations: upTo(4),
    after: (dir) => { // one byte changed in transit: a bad stick, or someone's edit
      const p = join(dir, "model/weights.bin");
      const b = readFileSync(p);
      b[4096] ^= 0x01;
      writeFileSync(p, b);
    } },
  { media: "03-agent-1.10.1-resent", date: "2026-12-05", version: "1.10.1", migrations: upTo(4),
    after: (dir) => { // someone on the low side "helped"
      mkdirSync(join(dir, "tools"), { recursive: true });
      writeFileSync(join(dir, "tools/debug-shell.sh"), "#!/bin/sh\n# opens a shell for remote debugging\nnc -l -p 4444 -e /bin/sh\n");
    } },
  { media: "04-agent-1.10.1-clean", date: "2026-12-08", version: "1.10.1", migrations: upTo(4) },
  { media: "05-agent-1.11.0", date: "2026-12-10", version: "1.11.0", migrations: upTo(5), signer: "stranger", image: "1.11.0-unknown" },
  { media: "06-agent-1.9.2", date: "2026-12-11", version: "1.9.2", migrations: upTo(3) },
  { media: "07-agent-1.11.0", date: "2026-12-14", version: "1.11.0", migrations: upTo(5), config: CONFIG_PHONES_HOME },
  { media: "08-agent-1.11.1", date: "2026-12-16", version: "1.11.1", migrations: upTo(6), broken0006: true },
  { media: "09-agent-1.11.2", date: "2026-12-18", version: "1.11.2", migrations: upTo(6) },
];

function build(spec: Spec): string {
  const dir = join(MEDIA, spec.media);
  const files: Record<string, Uint8Array> = {
    "config.json": text(JSON.stringify(spec.config ?? CONFIG, null, 2) + "\n"),
    "image/agent.tar": bytes(`image-${spec.image ?? spec.version}`, 48 * 1024),
    "model/weights.bin": bytes("weights-local-70b-instruct-q4", 192 * 1024),
  };
  for (const m of spec.migrations) {
    files[`migrations/${m}`] = text(spec.broken0006 && m.startsWith("0006") ? BROKEN_0006 : MIGRATIONS[m]);
  }
  const manifest: Manifest = {
    name: "support-agent",
    version: spec.version,
    created: `${spec.date}T06:00:00Z`,
    files: Object.entries(files)
      .map(([path, b]) => ({ path, sha256: sha256(b), bytes: b.length }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  const manifestBytes = text(JSON.stringify(manifest, null, 2) + "\n");
  const signer = spec.signer === "stranger" ? stranger : vendor;
  files["manifest.json"] = manifestBytes;
  files["manifest.sig"] = text(sign(null, manifestBytes, signer.privateKey).toString("base64") + "\n");
  files["signing-key.pub"] = text(pem(signer.publicKey));
  for (const [path, b] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), b);
  }
  spec.after?.(dir);
  return dir;
}

// ---------------------------------------------------------------------------------------------
// The high side, as it was before December: 1.9.2 installed, migrations 0001 to 0003 applied.
rmSync(MEDIA, { recursive: true, force: true });
const dirs = MEDIA_LIST.map(build);
const manifestHash = (dir: string) => sha256(readFileSync(join(dir, "manifest.json")));
const v192 = manifestHash(join(MEDIA, "06-agent-1.9.2"));

await db.exec(upTo(3).map((m) => MIGRATIONS[m]).join(""));
await db.exec(`
  create table schema_migrations (
    id         text primary key,                 -- the file name without ".sql", e.g. '0003_approvals'
    applied_at timestamptz not null
  );
  insert into schema_migrations values
    ('0001_requests', '2026-06-02T09:00:00Z'), ('0002_drafts', '2026-06-02T09:00:00Z'), ('0003_approvals', '2026-09-15T09:00:00Z');

  -- What runs now. Exactly one row.
  create table deployment (
    id              int primary key check (id = 1),
    version         text not null,
    manifest_sha256 text not null,               -- sha256 of the installed bundle's manifest.json
    installed_at    timestamptz not null
  );
  insert into deployment values (1, '1.9.2', '${v192}', '2026-09-15T09:00:00Z');

  -- One row per call to importBundle(), installed or refused. You write it; the accreditor reads it.
  create table import_log (
    id              serial primary key,
    at              timestamptz not null,        -- now() from this file
    media           text not null,               -- the bundle's folder name, e.g. '01-agent-1.10.0'
    version         text,                        -- the version manifest.json claims, if it could be read
    manifest_sha256 text,                        -- sha256 of manifest.json as it arrived, if there was one
    outcome         text not null check (outcome in ('installed', 'refused')),
    reason          text                         -- why it was refused, in words Ingrid understands
  );
`);

// ---------------------------------------------------------------------------------------------
// The checks.

type State = { version: string; migrations: string[]; modelVersionColumn: boolean; toolCalls: boolean; index: boolean };
async function state(): Promise<State> {
  const d = await db.query<{ version: string }>("select version from deployment where id = 1");
  const m = await db.query<{ id: string }>("select id from schema_migrations order by id");
  const c = await db.query<{ n: number }>(
    "select count(*)::int as n from information_schema.columns where table_name = 'drafts' and column_name = 'model_version'");
  const t = await db.query<{ t: string | null }>("select to_regclass('tool_calls')::text as t");
  const i = await db.query<{ i: string | null }>("select to_regclass('tool_calls_by_draft')::text as i");
  return {
    version: d.rows[0]?.version ?? "?",
    migrations: m.rows.map((r) => r.id),
    modelVersionColumn: c.rows[0].n === 1,
    toolCalls: t.rows[0].t !== null,
    index: i.rows[0].i !== null,
  };
}

export async function runChecks(importer: Importer) {
  type Attempt = { media: string; result: Result; after: State; manifest: string };
  const attempts: Attempt[] = [];
  for (const [i, dir] of dirs.entries()) {
    clock = Date.parse(`${MEDIA_LIST[i].date}T10:00:00Z`);
    let result: Result;
    try {
      result = await importer.importBundle(dir);
    } catch (e) {
      result = { ok: false, error: `crashed: ${(e as Error).message}` };
    }
    attempts.push({ media: MEDIA_LIST[i].media, result, after: await state(), manifest: manifestHash(dir) });
  }
  const at = (media: string) => attempts.find((a) => a.media.startsWith(media))!;
  const show = (a: Attempt) => (a.result.ok ? `installed ${a.result.version}` : `refused ("${a.result.error}")`);
  const short = (a: Attempt) => (a.result.ok ? "installed" : a.result.error.startsWith("crashed") ? "crashed" : "refused");
  const said = (a: Attempt, ...words: string[]) => !a.result.ok && words.every((w) => a.result.ok === false && a.result.error.includes(w));

  type LogRow = { at: Date; media: string; version: string | null; manifest_sha256: string | null; outcome: string; reason: string | null };
  let logRows: LogRow[] = [];
  let logError = "";
  try {
    logRows = (await db.query<LogRow>("select at, media, version, manifest_sha256, outcome, reason from import_log order by id")).rows;
  } catch (e) {
    logError = (e as Error).message;
  }

  const results: [boolean, string, string][] = [];
  const check = (name: string, fn: () => [boolean, string]) => {
    try {
      const [ok, detail] = fn();
      results.push([ok, name, detail]);
    } catch (e) {
      results.push([false, name, `crashed: ${(e as Error).message}`]);
    }
  };

  // 1. A release goes in whole, or not at all: files checked, migrations and version in one step.
  check("Installs whole, or not at all", () => {
    const a1 = at("01"), a8 = at("08"), a9 = at("09"), before8 = at("07").after;
    const ok1 = a1.result.ok && a1.after.version === "1.10.0" && a1.after.modelVersionColumn && a1.after.migrations.includes("0004_model_version");
    const ok8 = !a8.result.ok && a8.after.version === before8.version && !a8.after.toolCalls &&
      JSON.stringify(a8.after.migrations) === JSON.stringify(before8.migrations);
    const ok9 = a9.result.ok && a9.after.version === "1.11.2" && a9.after.toolCalls && a9.after.index &&
      a9.after.migrations.includes("0006_tool_calls_index");
    return [ok1 && ok8 && ok9,
      `1.10.0 -> ${short(a1)}, running ${a1.after.version}, 0004 ${a1.after.migrations.includes("0004_model_version") ? "applied" : "missing"}; ` +
      `1.11.1 (migration 0006 fails) -> ${short(a8)}, then running ${a8.after.version}, tool_calls ${a8.after.toolCalls ? "exists" : "absent"}; ` +
      `1.11.2 -> ${short(a9)}, running ${a9.after.version} ` +
      `(want 1.10.0 with 0004; 1.11.1 refused with nothing changed; 1.11.2 with 0005 and 0006)`];
  });

  // 2. Every file's hash and size match the signed manifest. A refusal changes nothing.
  check("Every file matches the manifest", () => {
    const a2 = at("02"), a4 = at("04");
    const ok = said(a2, "model/weights.bin") && a2.after.version === at("01").after.version && a4.result.ok && a4.after.version === "1.10.1";
    return [ok, `02 (one byte changed in weights.bin) -> ${show(a2)}; 04 (clean copy) -> ${short(a4)} ` +
      `(want 02 refused naming model/weights.bin, still running 1.10.0; then 04 installed)`];
  });

  // 3. The signature covers the manifest, and the manifest lists the files. Anything else is unsigned.
  check("Nothing outside the manifest", () => {
    const a3 = at("03");
    return [said(a3, "tools/debug-shell.sh") && a3.after.version === at("02").after.version,
      `03 (extra tools/debug-shell.sh) -> ${show(a3)} (want refused, naming tools/debug-shell.sh)`];
  });

  // 4. Only the key pinned at accreditation counts, and the high side never tries to call out.
  check("Trusts only the pinned key, offline", () => {
    const a5 = at("05");
    const ok = !a5.result.ok && !a5.result.error.startsWith("crashed") && a5.after.version === at("04").after.version && outbound.length === 0;
    return [ok, `05 (signed by another key, which it brings along) -> ${show(a5)}; outbound connection attempts: ${outbound.length}` +
      `${outbound.length ? ` (${[...new Set(outbound)].join(", ")})` : ""} (want refused, and 0 attempts)`];
  });

  // 5. An old, genuinely signed bundle is still old. Versions compare as numbers, part by part.
  check("Never goes backwards", () => {
    const a1 = at("01"), a6 = at("06");
    const ok = a1.result.ok && !a6.result.ok && !a6.result.error.startsWith("crashed") && a6.after.version === "1.10.1";
    return [ok, `1.10.0 over 1.9.2 -> ${short(a1)}; 06 (the old 1.9.2 bundle, found on a stick) -> ${show(a6)}, ` +
      `then running ${a6.after.version} (want 1.10.0 installed, 1.9.2 refused, still running 1.10.1)`];
  });

  // 6. A valid signature says who built it, not that it's safe here. Every URL must stay inside.
  check("Nothing in the release calls out", () => {
    const a7 = at("07"), a9 = at("09");
    const ok = said(a7, "telemetry_endpoint", "crash_reports.url") && a7.after.version === "1.10.1" && a9.result.ok;
    return [ok, `07 (vendor defaults left in config.json) -> ${show(a7)}; 09 (only ${INSIDE} hosts) -> ${short(a9)} ` +
      `(want 07 refused naming telemetry_endpoint and crash_reports.url; 09 installed)`];
  });

  // 7. The accreditor's record: every attempt, in order, with the manifest's hash.
  check("Logs every import", () => {
    if (logError) return [false, `couldn't read import_log: ${logError}`];
    const rows = logRows;
    const bad: string[] = [];
    attempts.forEach((a, i) => {
      const r = rows[i];
      if (!r) return void bad.push(`${a.media} has no row`);
      if (r.media !== a.media) return void bad.push(`row ${i + 1} is ${r.media}, want ${a.media}`);
      const want = a.result.ok ? "installed" : "refused";
      if (r.outcome !== want) bad.push(`${a.media} logged ${r.outcome}, want ${want}`);
      else if (r.manifest_sha256 !== a.manifest) bad.push(`${a.media} has the wrong manifest_sha256`);
      else if (want === "refused" && !r.reason) bad.push(`${a.media} has no reason`);
      else if (r.version !== MEDIA_LIST[i].version) bad.push(`${a.media} logged version ${r.version}, want ${MEDIA_LIST[i].version}`);
    });
    const ok = bad.length === 0 && rows.length === attempts.length;
    return [ok, `${rows.length} row(s) for ${attempts.length} imports` +
      `${bad.length ? `; ${bad.slice(0, 2).join("; ")}${bad.length > 2 ? `; and ${bad.length - 2} more` : ""}` : ""} ` +
      `(want one row per import, in order, with the media, the claimed version, the manifest's sha256, the outcome, and a reason for each refusal)`];
  });

  for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  const passed = results.filter((r) => r[0]).length;
  console.log(`\n${passed}/${results.length} checks pass.`);

  // What Torvik's accreditor reads.
  console.log("\nThe import log, as Torvik's accreditor reads it:");
  if (!logRows.length) console.log("  (empty)");
  for (const r of logRows) {
    const day = new Date(r.at).toISOString().slice(5, 10);
    const hash = r.manifest_sha256 ? r.manifest_sha256.slice(0, 12) : "-".repeat(12);
    console.log(`  ${day}  ${r.media.padEnd(24)} ${String(r.version ?? "?").padEnd(7)} ${hash}  ${r.outcome}` +
      `${r.reason ? `: ${r.reason.length > 80 ? r.reason.slice(0, 79) + "…" : r.reason}` : ""}`);
  }
  const s = await state();
  console.log(`\nRunning now: ${s.version}. Migrations: ${s.migrations.map((m) => m.slice(0, 4)).join(", ")}.`);
  await db.close(); // without this, PGlite can keep the process alive for several seconds
}
