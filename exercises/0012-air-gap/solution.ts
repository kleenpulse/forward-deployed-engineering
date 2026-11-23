// Lesson 12 exercise: worked solution. Try start.ts first.
// Run: bun exercises/0012-air-gap/solution.ts
import { basename, join } from "node:path";
import {
  db, INSIDE, listFiles, now, PINNED_KEY, runChecks, sha256, verifySignature,
  type Manifest, type Result,
} from "./harness.ts";

const ENVELOPE = new Set(["manifest.json", "manifest.sig", "signing-key.pub"]);

/** 1 if a is newer than b, -1 if older, 0 if equal. "1.10.0" vs "1.9.2" compares 10 with 9, not "1" with "9". */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Every string in the config that is a URL, with its key path: [["crash_reports.url", "https://…"], …]. */
function urls(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? [[path, value]] : [];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => urls(v, path ? `${path}.${k}` : k));
  }
  return [];
}

const inside = (url: string) => {
  try {
    const host = new URL(url).hostname; // the host, lower-cased: not the path, not the query
    return host === INSIDE || host.endsWith("." + INSIDE);
  } catch {
    return false;
  }
};

async function importBundle(dir: string): Promise<Result> {
  const entry = { media: basename(dir), version: null as string | null, manifestHash: null as string | null };
  let result: Result;
  try {
    result = await check(dir, entry);
  } catch (e) {
    result = { ok: false, error: `Import failed: ${(e as Error).message}. Nothing was changed.` };
  }
  await db.query(
    "insert into import_log (at, media, version, manifest_sha256, outcome, reason) values ($1, $2, $3, $4, $5, $6)",
    [now().toISOString(), entry.media, entry.version, entry.manifestHash,
      result.ok ? "installed" : "refused", result.ok ? null : result.error]);
  return result;
}

async function check(dir: string, entry: { version: string | null; manifestHash: string | null }): Promise<Result> {
  const refuse = (error: string): Result => ({ ok: false, error });
  const present = listFiles(dir);
  if (!present.includes("manifest.json") || !present.includes("manifest.sig")) {
    return refuse("No manifest.json or manifest.sig on the media. Nothing was changed.");
  }

  // The signature first, with the key pinned at accreditation. Nothing in the manifest counts before this.
  const manifestBytes = await Bun.file(join(dir, "manifest.json")).bytes();
  entry.manifestHash = sha256(manifestBytes);
  const signature = await Bun.file(join(dir, "manifest.sig")).text();
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    entry.version = typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return refuse("manifest.json isn't valid JSON. Nothing was changed.");
  }
  if (!verifySignature(PINNED_KEY, manifestBytes, signature)) {
    return refuse("manifest.sig wasn't made by the vendor's release key pinned on the high side. " +
      "A key that comes with the media proves nothing. Nothing was changed.");
  }

  // The manifest lists the files; anything else on the media isn't covered by the signature.
  const listed = new Set(manifest.files.map((f) => f.path));
  const extra = present.filter((p) => !ENVELOPE.has(p) && !listed.has(p));
  const missing = [...listed].filter((p) => !present.includes(p));
  if (extra.length) return refuse(`Files on the media that the signed manifest doesn't list: ${extra.join(", ")}. Nothing was changed.`);
  if (missing.length) return refuse(`Files the manifest lists that aren't on the media: ${missing.join(", ")}. Nothing was changed.`);

  for (const f of manifest.files) {
    const b = await Bun.file(join(dir, f.path)).bytes();
    if (b.length !== f.bytes || sha256(b) !== f.sha256) {
      return refuse(`${f.path} doesn't match the signed manifest (changed or damaged after signing). Nothing was changed.`);
    }
  }

  // Forward only.
  const { rows: [running] } = await db.query<{ version: string }>("select version from deployment where id = 1");
  if (compareVersions(manifest.version, running.version) <= 0) {
    return refuse(`${manifest.version} isn't newer than ${running.version}, which is running now. Nothing was changed.`);
  }

  // A valid signature says who built it, not that it's safe here.
  const config = JSON.parse(await Bun.file(join(dir, "config.json")).text());
  const outside = urls(config).filter(([, u]) => !inside(u));
  if (outside.length) {
    return refuse(`config.json points outside ${INSIDE}: ${outside.map(([k, u]) => `${k} (${new URL(u).hostname})`).join(", ")}. ` +
      "Ask the vendor for a build without them. Nothing was changed.");
  }

  // All checks passed. Migrations, their records and the version switch: one transaction.
  try {
    await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from schema_migrations");
      const done = new Set(rows.map((r) => r.id));
      const migrations = manifest.files.map((f) => f.path).filter((p) => p.startsWith("migrations/")).sort();
      for (const path of migrations) {
        const id = path.slice("migrations/".length, -".sql".length);
        if (done.has(id)) continue;
        await tx.exec(await Bun.file(join(dir, path)).text());
        await tx.query("insert into schema_migrations values ($1, $2)", [id, now().toISOString()]);
      }
      await tx.query("update deployment set version = $1, manifest_sha256 = $2, installed_at = $3 where id = 1",
        [manifest.version, entry.manifestHash, now().toISOString()]);
    });
  } catch (e) {
    return refuse(`A database migration failed: ${(e as Error).message}. Everything was rolled back; ${running.version} is still running.`);
  }
  return { ok: true, version: manifest.version };
}

await runChecks({ importBundle });
