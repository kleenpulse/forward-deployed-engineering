// Checks every lesson and reference page: widget JSON parses, quiz options have
// equal word counts, correct answers move around, and local links resolve.
// Run: bun scripts/check-lessons.ts   (exits 1 on any problem)
import { Glob } from "bun";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

const root = resolve(import.meta.dir, "..");
const problems: string[] = [];
const words = (s: string) => s.replace(/<[^>]+>/g, "").trim().split(/\s+/).filter(Boolean).length;

const pages = [
  "index.html",
  ...new Glob("lessons/*.html").scanSync(root),
  ...new Glob("reference/*.html").scanSync(root),
].map((p) => p.replaceAll("\\", "/"));

for (const page of pages) {
  const html = await Bun.file(join(root, page)).text();

  for (const m of html.matchAll(/<script type="application\/json" data-(quiz|sort|practice)="([^"]+)">([\s\S]*?)<\/script>/g)) {
    const [, kind, id, body] = m;
    let data: any;
    try {
      data = JSON.parse(body);
    } catch (e) {
      problems.push(`${page}: ${kind} "${id}" is not valid JSON (${(e as Error).message})`);
      continue;
    }
    if (kind === "quiz") {
      const answers: number[] = [];
      data.questions.forEach((q: any, i: number) => {
        const counts = q.options.map(words);
        if (new Set(counts).size > 1) problems.push(`${page}: quiz "${id}" Q${i + 1} options have word counts ${counts.join("/")}`);
        if (!(q.answer >= 0 && q.answer < q.options.length)) problems.push(`${page}: quiz "${id}" Q${i + 1} answer index out of range`);
        if (!q.why) problems.push(`${page}: quiz "${id}" Q${i + 1} has no "why"`);
        answers.push(q.answer);
      });
      const used = new Set(answers);
      if (answers.length >= 4 && used.size < 3) problems.push(`${page}: quiz "${id}" correct answers sit in only ${used.size} positions (${answers.join(",")})`);
    }
    if (kind === "sort") {
      data.items.forEach((it: any, i: number) => {
        if (!(it.bucket >= 0 && it.bucket < data.buckets.length)) problems.push(`${page}: sort "${id}" item ${i + 1} has a bad bucket`);
        if (!it.why) problems.push(`${page}: sort "${id}" item ${i + 1} has no "why"`);
      });
    }
    if (kind === "practice" && !(data.fields?.length && data.checks?.length)) problems.push(`${page}: practice "${id}" needs fields and checks`);
  }

  for (const m of html.matchAll(/(?:href|src)="([^"#?]+)(?:[#?][^"]*)?"/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|data:)/.test(target)) continue;
    if (!existsSync(join(root, dirname(page), target))) problems.push(`${page}: broken local link ${target}`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s) in ${pages.length} pages.`);
  process.exit(1);
}
console.log(`All ${pages.length} pages pass.`);
