// Lesson 12 exercise: the import gate for release bundles on Torvik's high side.
// Run: bun exercises/0012-air-gap/start.ts
//
// Your job: make every check print PASS. Read the top of harness.ts first: it describes a bundle,
// the pinned key, the deployment and schema_migrations tables, and the import_log table.
// The bundles themselves are written to exercises/0012-air-gap/media/ on every run. Open them.
import { join } from "node:path";
import { db, listFiles, now, runChecks, sha256, verifySignature, type Manifest, type Result } from "./harness.ts";

// The import script most teams write first. It checks a signature, so it feels safe.
async function importBundle(dir: string): Promise<Result> {
  const manifestBytes = await Bun.file(join(dir, "manifest.json")).bytes();
  const signature = await Bun.file(join(dir, "manifest.sig")).text();

  // Fetch the vendor's current key, so key rotation "just works". Offline? Use the copy in the bundle.
  let key: string;
  try {
    key = await (await fetch("https://releases.vendor.example/signing-key.pub")).text();
  } catch {
    key = await Bun.file(join(dir, "signing-key.pub")).text();
  }
  if (!verifySignature(key, manifestBytes, signature)) return { ok: false, error: "Bad signature." };

  const manifest: Manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  await db.query("update deployment set version = $1, manifest_sha256 = $2, installed_at = $3 where id = 1",
    [manifest.version, sha256(manifestBytes), now().toISOString()]);

  // Apply the migrations we don't have yet.
  const { rows } = await db.query<{ id: string }>("select id from schema_migrations");
  const done = new Set(rows.map((r) => r.id));
  for (const path of listFiles(dir).filter((p) => p.startsWith("migrations/"))) {
    const id = path.slice("migrations/".length, -".sql".length);
    if (done.has(id)) continue;
    await db.exec(await Bun.file(join(dir, path)).text());
    await db.query("insert into schema_migrations values ($1, $2)", [id, now().toISOString()]);
  }
  return { ok: true, version: manifest.version };
}

// TODO, in the order of the checks:
//   1. Install whole or not at all: apply the new migrations, record them, and update deployment
//      in ONE transaction (db.transaction). If a migration fails, nothing changes: refuse, with
//      the database's error in the reason.
//   2. Hash every file the manifest lists (sha256 and size). One mismatch refuses the bundle,
//      naming the file.
//   3. Refuse any file that isn't in the manifest (apart from manifest.json, manifest.sig and
//      signing-key.pub), and any listed file that's missing. The signature only covers the list.
//   4. Verify manifest.sig with PINNED_KEY from harness.ts, before you trust a word of the
//      manifest. Never the key in the bundle. Never the network: there is none.
//   5. Refuse a version that isn't newer than the one running. Compare the numbers part by
//      part: 1.10.0 is newer than 1.9.2.
//   6. Every URL in config.json, however deep, must have a host that is INSIDE or ends in
//      "." + INSIDE. Refuse the bundle and name each key that points elsewhere (e.g.
//      crash_reports.url). Check the host, not the whole string.
//   7. Write one import_log row for EVERY call, installed or refused: the folder name (media),
//      the version the manifest claims, sha256 of manifest.json as it arrived, the outcome, and
//      the reason for a refusal.
// Refuse with { ok: false, error } in words Ingrid understands. Never throw.

await runChecks({ importBundle });
