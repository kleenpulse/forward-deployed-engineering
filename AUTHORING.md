# Writing a lesson

How lessons in this course are built. Read it before adding or changing a lesson.

## Who the course is for

Software engineers with a few years of experience who want a Forward Deployed Engineer (FDE) job, the "Builder" kind: embedded with a customer, mostly writing code. They know web apps, APIs and some SQL. They do **not** know enterprise jargon (SSO, SCIM, VPC, ETL, HITL…), so every term gets defined.

Write for one reader working alone. There is no tutor in the loop.

- Second person ("you"). Never "I read your portfolio" or "paste it to me".
- Plain, short sentences. Simple English that a non-native speaker reads easily. No hype, no "game-changer", no "you'll never be unemployed".
- Every factual claim is cited, ideally to a primary source (a spec, official docs, a company's own post, a real job ad). Don't write claims from memory. If you can't find a source, leave the claim out.

## Course order

The 12 stages come from [Suraj Sharma's FDE roadmap](https://x.com/suraj_sharma14/status/2124827808535048566). Lessons teach the 9 core stages first, in the order the job runs them, then the 3 specialist stages.

| Lesson | Stage | File | Status |
|---|---|---|---|
| 1 | Overview | `lessons/0001-the-real-job-behind-the-roadmap.html` | done |
| 2 | 11 · Discovery & scoping | `lessons/0002-discovery-and-scoping.html` | done |
| 3 | 1 · Enterprise identity & agent access | `lessons/0003-enterprise-identity-for-agents.html` | done |
| 4 | 4 · Permission-filtered retrieval | `lessons/0004-permission-filtered-retrieval.html` | done |
| 5 | 5 · MCP & legacy integration | `lessons/0005-mcp-and-legacy-integration.html` | done |
| 6 | 3 · Legacy data & ETL | `lessons/0006-legacy-data-and-etl.html` | planned |
| 7 | 7 · Human-in-the-loop & durable workflows | `lessons/0007-human-in-the-loop-workflows.html` | planned |
| 8 | 10 · Evals on customer data | `lessons/0008-evals-on-customer-data.html` | planned |
| 9 | 9 · Telemetry, ROI & customer health | `lessons/0009-telemetry-and-roi.html` | planned |
| 10 | 12 · Handoff & self-serve admin | `lessons/0010-handoff-and-self-serve.html` | planned |
| 11 | 6 · PII guardrails (specialist) | `lessons/0011-pii-guardrails.html` | planned |
| 12 | 2 · Air-gapped & VPC deployment (specialist) | `lessons/0012-air-gapped-and-vpc.html` | planned |
| 13 | 8 · Edge & on-prem inference (specialist) | `lessons/0013-on-prem-inference.html` | planned |

The syllabus in `index.html` mirrors this table. When a lesson ships, link it there and in the previous lesson's "Up next" line.

## Shape of a lesson

About 60 minutes: roughly 20 of reading, 40 of doing. One tangible win, stated at the top. Teach only the knowledge the win needs, then make the reader practise it with instant feedback.

Copy `lessons/0001-the-real-job-behind-the-roadmap.html` as the skeleton. In order:

1. `<head>`: `../assets/course.css`, then `../assets/theme.js` (not deferred), then `../assets/scroll-ring.js` and `../assets/scrollbar.js`, both with `defer`.
2. `<nav class="course">`: Course index · previous lesson · next lesson (only if it exists) · Roadmap reference · Jargon decoder.
3. `.kicker` ("Forward Deployed Engineering · Lesson N · Stage S · about 60 minutes"), `h1`, `.subtitle`, and the `small no-terms` hint line about dotted words.
4. `.win`: what the reader will have at the end.
5. Numbered `h2` sections. Knowledge first, then practice.
6. At least one quiz, plus a sort or a practice pad (or both). For build-heavy stages, add an exercise (see below).
7. A `.callout` with `.kicker` "Primary source · read next · N minutes": the single best source on the topic.
8. The `.ask` box (text below).
9. "Up next" line in `p.small`.
10. Scripts at the end of `<body>`: the widgets you used, then `terms.js`, then `tooltip.js`.

Standard ask box:

```html
<div class="ask">
  <p><strong>Stuck, or disagree?</strong> Ask in the course's <a href="https://github.com/kleenpulse/forward-deployed-engineering/discussions">GitHub Discussions</a>, where other learners and people doing the job can answer. You can also paste this page into an AI assistant and ask it to quiz you on the parts you got wrong.</p>
</div>
```

## Components (`assets/`)

Reuse these. Don't inline code that another lesson would duplicate; add a new component to `assets/` instead.

- **Side notes (citations):** `text.<span class="sn-ref"></span><span class="sidenote numbered">Source text with a <a href="…">link</a>.</span>` Numbers are automatic. They sit in the margin on wide screens and inline on narrow ones.
- **Quiz:** `<script type="application/json" data-quiz="lN-id">{ "questions": [{ "q": "…", "options": ["…","…","…","…"], "answer": 2, "why": "…" }] }</script>` plus `../assets/quiz.js`.
  - Every option in a question has **the same number of words** (and about the same length).
  - Move the correct answer around. Use at least three different positions across the quiz.
  - No clues in formatting, length or "all of the above".
  - `why` explains the answer and cites the source.
  - From Lesson 3 on, include one or two questions from earlier lessons (spacing).
- **Sort:** `data-sort="lN-id"`, `{ "buckets": ["A","B"], "items": [{ "label": "…", "detail": "…", "bucket": 0, "why": "…" }] }` plus `../assets/sort.js`.
- **Practice pad:** `data-practice="lN-id"`, `{ "title": "…", "maxWords": 150, "fields": [{ "key": "k", "label": "…", "hint": "…" }], "checks": ["…"] }` plus `../assets/practice.js`. The self-check list *is* the feedback, so make each check specific and testable.
- **Callouts:** `.win`, `.callout`, `.ask`. Tags: `<span class="tag core">core</span>`, `tag spec`.
- **Bars:** see Lesson 1, section 2.
- **Code:** `<figure class="code"><figcaption>exercises/0003-…/file.ts</figcaption><pre><code>…</code></pre></figure>`. Escape `<`, `>` and `&` inside `<pre>`. Wrap comments in `<span class="c">…</span>` to dim them.

## Jargon

`assets/terms.js` is the single glossary. Tooltips and `reference/jargon.html` both read it.

- Before a lesson uses a term or abbreviation, it must be in `terms.js`. Check first; don't duplicate.
- Format: `{ term, full?, match: [spellings], ci?: true, def }`. Acronyms match case-sensitively. Set `ci: true` for phrases.
- Definitions: one or two plain sentences, concrete, with an example where it helps.

## Exercises (hands-on code)

For stages that are built, not discussed, add a small runnable exercise:

- Put it in `exercises/000N-slug/`. TypeScript, run with Bun: `bun exercises/000N-slug/start.ts`.
- **No accounts and no API keys.** For Postgres, use PGlite (`@electric-sql/pglite`, already a dev dependency). It runs real Postgres in-process. Note: PGlite 0.6 doesn't bundle pgvector, so use Postgres full-text search for retrieval.
- Give the reader a starting file with a clear TODO and a check that prints PASS/FAIL, so the feedback is automatic. Keep a worked solution in `solution.ts` next to it.
- Run both files before shipping. Paste the real output into the lesson.

## Before you ship

```
bun scripts/check-lessons.ts
```

It checks widget JSON, quiz word counts, answer positions and local links. Then open the page with `bun run dev` (Vite, http://localhost:5173), click through every widget, and hover a few dotted terms.
