# Forward Deployed Engineering: a free course

**Read it here: https://kleenpulse.github.io/forward-deployed-engineering/**

A free, open course for software engineers who want a Forward Deployed Engineer (FDE) job: the kind where you embed with one customer and ship AI into their real systems.

The course follows the 12 stages of [Suraj Sharma's FDE roadmap](https://x.com/suraj_sharma14/status/2124827808535048566), checked against [an analysis of 1,000 real FDE job ads](https://bloomberry.com/blog/i-analyzed-1000-forward-deployed-engineer-jobs-what-i-learned/). It teaches the nine core stages first, in the order the job runs them, then the three specialist ones.

- **13 lessons of about an hour each.** Each one teaches one stage, then makes you practise it with quizzes, sorting exercises, writing tasks and small code exercises with instant feedback.
- **No account, no API keys.** Answers save in your browser. Code exercises run with [Bun](https://bun.sh) and [PGlite](https://pglite.dev) (a real Postgres that runs inside the script).
- **Every claim is cited.** Hover any dotted word for a plain-English definition, or search the [jargon decoder](https://kleenpulse.github.io/forward-deployed-engineering/reference/jargon.html).

| # | Lesson | Stage | Status |
|---|---|---|---|
| 1 | The real job behind the roadmap | Overview | ✅ |
| 2 | Discovery and scoping | 11 | ✅ |
| 3 | Enterprise identity for agents | 1 | ✅ |
| 4 | Permission-filtered retrieval | 4 | ✅ |
| 5 | MCP and legacy integration | 5 | ✅ |
| 6 | Legacy data and ETL | 3 | ✅ |
| 7 | Human-in-the-loop and durable workflows | 7 | ✅ |
| 8 | Evals on customer data | 10 | coming soon |
| 9 | Telemetry, ROI and customer health | 9 | coming soon |
| 10 | Handoff and self-serve admin | 12 | coming soon |
| 11 | PII guardrails (specialist) | 6 | coming soon |
| 12 | Air-gapped and VPC deployment (specialist) | 2 | coming soon |
| 13 | Edge and on-prem inference (specialist) | 8 | coming soon |

## Run it locally

```sh
git clone https://github.com/kleenpulse/forward-deployed-engineering
cd forward-deployed-engineering
bun install
bun run dev                              # the site, with reload on save, at http://localhost:5173
bun exercises/0003-identity/start.ts     # a code exercise
```

The site is plain HTML, CSS and JavaScript with no build step, so you can also open `index.html` straight from disk.

## Contributing

Corrections, better sources and new lessons are welcome. Read [AUTHORING.md](AUTHORING.md) first: it covers the audience, the voice, the components and the quiz rules. Then run `bun scripts/check-lessons.ts` before you open a pull request. Questions go in [Discussions](https://github.com/kleenpulse/forward-deployed-engineering/discussions).

## Licence

Lesson text: [CC BY 4.0](LICENSE-CONTENT.md). Code: [MIT](LICENSE). Fonts (Mozilla Text, Cascadia Code): SIL Open Font License 1.1.
