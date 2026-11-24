// Shared setup and checks for the Lesson 13 exercise. You don't need to edit this file.
//
// Torvik's agent is accredited (Lesson 12). Now it needs a model on the high side. Torvik has one
// GPU server, gpu-01.torvik.internal, with two NVIDIA L40S cards. Mats runs it. Four versions of
// one open-weight model family, Skerry, crossed the gap in signed bundles. Each one is a folder
// under /models in the image. Your job is to pick the one Torvik will run, and prove it's good enough.
//
// You write three functions (see start.ts):
//   fit(model, settings)          will this model, served this way, fit on the two GPUs?
//   serveCommand(model, settings) the exact `vllm serve` command Mats will run
//   accept(reference, trial)      is a trial run good enough to replace the reference?
//
// Units: GB means 10^9 bytes everywhere in this file. (vLLM's own logs print GiB, 2^30 bytes.)
//
// What's here:
//   GPUS       the server's cards
//   NEEDS      what Torvik's support team needs, from discovery (Lesson 2)
//   AGENT      what the agent sends: the model name it asks for, and that it uses tools
//   MODELS     the four Skerry versions: each one's config.json fields, size on disk, local path
//   OVERHEAD_GB_PER_GPU   memory vLLM needs on each GPU besides weights and KV cache, measured
//   reference  the golden-set grades of the full-precision model (Lesson 8's format)
//   MATS_LOG   two trials Mats ran last week, for you to judge
//   vllm()     a stand-in for vLLM: give it argv and env, and it boots (or refuses to), then
//              answers the golden set and a load test. It has no GPU and no model: it follows
//              vLLM's documented rules and replays what Torvik measured.

export type Model = {
  id: string;
  path: string; // where the weights are inside the image
  hub_id: string; // where they came from on the low side. On the high side, there is no hub.
  format: "bf16" | "fp8" | "awq-int4"; // how the weights are stored
  weights_bytes: number; // total size of the weight files
  tool_call_parser: string; // from the model card: the parser vLLM needs to read its tool calls
  config: {
    // the fields of config.json that matter for memory
    num_hidden_layers: number;
    num_attention_heads: number;
    num_key_value_heads: number;
    head_dim: number;
    max_position_embeddings: number;
    dtype: "bfloat16";
  };
};

export type Settings = {
  tensor_parallel_size: number; // how many GPUs share the model
  kv_cache_dtype: "auto" | "fp8"; // auto = the model's dtype (bfloat16, 2 bytes); fp8 = 1 byte
  max_model_len: number; // the longest request, prompt plus reply, in tokens
  gpu_memory_utilization: number; // the share of each GPU's memory vLLM may use. Mats sets 0.9: a tenth of each
  // card stays free for the GPU monitoring tools that run beside vLLM, which vLLM doesn't measure.
};

export type Fit = {
  weights_gb: number; // all weights, across the GPUs
  overhead_gb: number; // OVERHEAD_GB_PER_GPU, for every GPU used
  budget_gb: number; // what vLLM may use, across the GPUs
  kv_bytes_per_token: number; // the KV cache one token needs, across all layers
  kv_room_gb: number; // budget minus weights minus overhead: what's left for the KV cache
  max_concurrency: number; // how many max_model_len requests fit in kv_room_gb at once
  fits: boolean; // room for NEEDS.concurrency requests of max_model_len tokens
};

export type Command = { argv: string[]; env: Record<string, string> };

/** One golden-set run, graded (Lesson 8). error is set when the request itself failed. */
export type Grade = { case_id: string; trial: number; pass: boolean; error?: string };
/** p95 time to first token, in seconds, with this many conversations at once. */
export type Load = { concurrency: number; ttft_p95_s: number };
export type Trial = { label: string; grades: Grade[]; load: Load[] };
export type Decision = { ship: boolean; regressions: string[]; reasons: string[] };

export type Planner = {
  fit: (model: Model, s: Settings) => Fit;
  serveCommand: (model: Model, s: Settings) => Command;
  accept: (reference: Grade[], trial: Trial) => Decision;
};

export const GB = 1e9;
const GiB = 2 ** 30;
export const GPUS = { count: 2, name: "NVIDIA L40S", memory_gb: 48 };
export const OVERHEAD_GB_PER_GPU = 2.5; // activations, CUDA graphs, the CUDA context: vLLM's profiling run on gpu-01
export const NEEDS = {
  concurrency: 16, // conversations at once, at the busiest hour of the pilot
  context: 16_384, // tokens: the longest golden case is a manual chapter plus a thread, 14,900 tokens
  ttft_p95_s: 2.0, // the first words of a reply within 2 s, for 95% of requests, at that peak
};
export const AGENT = { base_url: "http://llm.torvik.internal:8000/v1", model: "torvik-support", uses_tools: true };

// Skerry-32B is shaped like Qwen3-32B (huggingface.co/Qwen/Qwen3-32B, config.json). Skerry-14B is smaller.
const arch32 = { num_hidden_layers: 64, num_attention_heads: 64, num_key_value_heads: 8, head_dim: 128, max_position_embeddings: 40_960, dtype: "bfloat16" as const };
const arch14 = { num_hidden_layers: 48, num_attention_heads: 40, num_key_value_heads: 8, head_dim: 128, max_position_embeddings: 40_960, dtype: "bfloat16" as const };

export const MODELS: Model[] = [
  { id: "skerry-32b", path: "/models/skerry-32b-instruct", hub_id: "skerry-ai/Skerry-32B-Instruct", format: "bf16", weights_bytes: 65.6 * GB, tool_call_parser: "hermes", config: arch32 },
  { id: "skerry-32b-fp8", path: "/models/skerry-32b-instruct-fp8", hub_id: "skerry-ai/Skerry-32B-Instruct-FP8", format: "fp8", weights_bytes: 33.4 * GB, tool_call_parser: "hermes", config: arch32 },
  { id: "skerry-32b-awq", path: "/models/skerry-32b-instruct-awq", hub_id: "skerry-ai/Skerry-32B-Instruct-AWQ", format: "awq-int4", weights_bytes: 19.4 * GB, tool_call_parser: "hermes", config: arch32 },
  { id: "skerry-14b", path: "/models/skerry-14b-instruct", hub_id: "skerry-ai/Skerry-14B-Instruct", format: "bf16", weights_bytes: 29.5 * GB, tool_call_parser: "hermes", config: arch14 },
];
export const model = (id: string) => MODELS.find((m) => m.id === id)!;

// ---------------------------------------------------------------------------------------------
// The golden set: twelve questions Torvik's field engineers asked in the pilot, each with the answer
// Torvik's support lead agreed is right. Six need a tool (get_part, get_work_order, open_rma).

export const CASES: { id: string; about: string; tools: boolean }[] = [
  { id: "T-01", about: "Which firmware fixes the TR-40 ping drift?", tools: false },
  { id: "T-02", about: "Status of work order WO-5521", tools: true },
  { id: "T-03", about: "Can the TR-40 and TR-42 share a junction box?", tools: false },
  { id: "T-04", about: "Is part 40-1187-C in stock in Bergen?", tools: true },
  { id: "T-05", about: "Open a return for a cracked TR-42 housing", tools: true },
  { id: "T-06", about: "Cable bend radius for the array harness", tools: false },
  { id: "T-07", about: "Torque for the TR-40 mounting bolts (2.85 Nm)", tools: false },
  { id: "T-08", about: "Which work orders are waiting for part 40-2210?", tools: true },
  { id: "T-09", about: "Summarise the 2026 service bulletin on seal wear", tools: false },
  { id: "T-10", about: "Who signed off WO-5498?", tools: true },
  { id: "T-11", about: "Replace a TR-40 or repair it? Use the warranty rules", tools: true },
  { id: "T-12", about: "Explain the self-test codes 0x31 to 0x3F", tools: false },
];

// What each model got right, per case, over three trials (P = pass, F = fail). Torvik's support lead
// graded these by hand. Cases not listed passed all three times. The KV cache dtype didn't change
// any grade in Torvik's runs, so one profile per model.
const PROFILE: Record<string, Record<string, string>> = {
  "skerry-32b": { "T-09": "PFP", "T-12": "FFF" },
  "skerry-32b-fp8": { "T-12": "FFF" },
  "skerry-32b-awq": { "T-07": "PFP", "T-12": "FPF" }, // in trial 2 it said 2.58 Nm
  "skerry-14b": { "T-03": "PFF", "T-07": "FFP", "T-09": "FFP", "T-11": "PPF", "T-12": "FFF" },
};
const TTFT_ALONE_S: Record<string, number> = { "skerry-32b": 0.62, "skerry-32b-fp8": 0.45, "skerry-32b-awq": 0.38, "skerry-14b": 0.3 };
const TURN_S = 5.5; // how long one reply takes to finish, on average: what a queued request waits

// ---------------------------------------------------------------------------------------------
// The stand-in for vLLM. The memory rule is vLLM's: the weights, the profiled overhead and the KV
// cache must fit in gpu_memory_utilization of every GPU, and the KV cache must hold at least one
// request of max_model_len tokens, or it refuses to start.

/** Network attempts the stand-in made. On the high side, each one is an alert for Ingrid. */
export const outbound: string[] = [];

type Server = {
  model: Model;
  settings: Settings;
  served_name: string;
  tools: boolean;
  max_concurrency: number;
  log: string[];
};

function trueFit(m: Model, s: Settings) {
  const kvPerToken = 2 * m.config.num_hidden_layers * m.config.num_key_value_heads * m.config.head_dim * (s.kv_cache_dtype === "fp8" ? 1 : 2);
  const budget = s.gpu_memory_utilization * GPUS.memory_gb * GB * s.tensor_parallel_size;
  const room = budget - m.weights_bytes - OVERHEAD_GB_PER_GPU * GB * s.tensor_parallel_size;
  return { kvPerToken, budget, room, maxConcurrency: room / (kvPerToken * s.max_model_len) };
}

const flag = (argv: string[], name: string) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i < 0) return undefined;
  return argv[i].includes("=") ? argv[i].split("=").slice(1).join("=") : argv[i + 1] ?? "";
};

/** Boot the stand-in from a command. Returns the server, or vLLM's error. */
export function vllm(cmd: Command): Server | { error: string } {
  const [bin, sub, target] = cmd.argv;
  if (bin !== "vllm" || sub !== "serve" || !target || target.startsWith("--")) return { error: "usage: vllm serve <model> [options]" };
  const log: string[] = [];
  let m = MODELS.find((x) => x.path === target);
  if (!m) {
    // Not a folder in the image: vLLM asks the Hugging Face Hub for it. Here, it was cached on the
    // low side, so the stand-in carries on, but every start-up is a blocked connection.
    m = MODELS.find((x) => x.hub_id === target);
    if (!m) return { error: `${target} is not a local folder or a model this server knows` };
    if (cmd.env.HF_HUB_OFFLINE !== "1") outbound.push(`https://huggingface.co/api/models/${target}`);
  }
  const tp = Number(flag(cmd.argv, "--tensor-parallel-size") ?? 1);
  const s: Settings = {
    tensor_parallel_size: tp,
    kv_cache_dtype: (flag(cmd.argv, "--kv-cache-dtype") ?? "auto") as Settings["kv_cache_dtype"],
    max_model_len: Number(flag(cmd.argv, "--max-model-len") ?? m.config.max_position_embeddings),
    gpu_memory_utilization: Number(flag(cmd.argv, "--gpu-memory-utilization") ?? 1.0), // vLLM's default on CUDA (extensible KV cache)
  };
  if (!(tp >= 1 && tp <= GPUS.count) || m.config.num_attention_heads % tp) return { error: `Total number of attention heads (${m.config.num_attention_heads}) must be divisible by tensor parallel size (${tp}).` };
  if (!["auto", "fp8"].includes(s.kv_cache_dtype)) return { error: `unsupported --kv-cache-dtype ${s.kv_cache_dtype}` };
  if (s.max_model_len > m.config.max_position_embeddings) return { error: `max_model_len ${s.max_model_len} is longer than the model allows (${m.config.max_position_embeddings})` };
  const f = trueFit(m, s);
  log.push(`Model loading took ${(m.weights_bytes / GiB / tp).toFixed(2)} GiB of memory per GPU (tensor parallel size ${tp})`);
  const hint = "Try increasing `gpu_memory_utilization` when initializing the engine.";
  if (f.room <= 0) return { error: `No available memory for the cache blocks. ${hint}` };
  if (f.maxConcurrency < 1) {
    const need = (f.kvPerToken * s.max_model_len) / GiB, have = f.room / GiB;
    return { error: `To serve at least one request with the model's max seq len (${s.max_model_len}), (${need.toFixed(2)} GiB KV cache is needed, ` +
      `which is larger than the available KV cache memory (${have.toFixed(2)} GiB). Based on the available memory, the estimated maximum model length is ` +
      `${Math.floor(f.room / f.kvPerToken)}. ${hint} Decreasing \`max_model_len\` also reduces what is needed.` };
  }
  log.push(`Available KV cache memory: ${(f.room / GiB).toFixed(2)} GiB`);
  log.push(`GPU KV cache size: ${Math.floor(f.room / f.kvPerToken).toLocaleString("en")} tokens, ` +
    `Maximum concurrency for ${s.max_model_len.toLocaleString("en")} tokens per request: ${f.maxConcurrency.toFixed(2)}x`);
  const served = flag(cmd.argv, "--served-model-name") ?? target;
  const tools = cmd.argv.includes("--enable-auto-tool-choice") && flag(cmd.argv, "--tool-call-parser") === m.tool_call_parser;
  return { model: m, settings: s, served_name: served, tools, max_concurrency: f.maxConcurrency, log };
}

/** The agent sends every golden case three times, as it would in production, and Torvik's grades come back. */
export function goldenSet(srv: Server): Grade[] {
  const out: Grade[] = [];
  for (const c of CASES) {
    for (let t = 1; t <= 3; t++) {
      let error: string | undefined;
      if (srv.served_name !== AGENT.model) error = `404: The model \`${AGENT.model}\` does not exist. Valid aliases: ${srv.served_name}.`;
      else if (c.tools && !srv.tools) error = `400: "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set`;
      const p = PROFILE[srv.model.id][c.id]?.[t - 1] ?? "P";
      out.push(error ? { case_id: c.id, trial: t, pass: false, error } : { case_id: c.id, trial: t, pass: p === "P" });
    }
  }
  return out;
}

/** Many conversations at once, each with a 14,900-token prompt. Beyond max_concurrency, requests wait their turn. */
export function loadTest(srv: Server): Load[] {
  return [1, 4, 8, 16].map((n) => {
    const running = Math.min(n, srv.max_concurrency);
    const wait = n > srv.max_concurrency ? TURN_S : 0;
    return { concurrency: n, ttft_p95_s: Math.round((TTFT_ALONE_S[srv.model.id] * (1 + running / 8) + wait) * 100) / 100 };
  });
}

/** The right command, for the reference run and Mats's log. */
function goodCommand(m: Model, s: Settings): Command {
  return {
    env: { HF_HUB_OFFLINE: "1" },
    argv: ["vllm", "serve", m.path, "--served-model-name", AGENT.model, "--tensor-parallel-size", String(s.tensor_parallel_size),
      "--max-model-len", String(s.max_model_len), "--kv-cache-dtype", s.kv_cache_dtype, "--gpu-memory-utilization", String(s.gpu_memory_utilization),
      "--enable-auto-tool-choice", "--tool-call-parser", m.tool_call_parser],
  };
}
function trialOf(label: string, m: Model, s: Settings): Trial {
  const srv = vllm(goodCommand(m, s)) as Server;
  return { label, grades: goldenSet(srv), load: loadTest(srv) };
}
const settings = (tp: number, kv: Settings["kv_cache_dtype"]): Settings => ({ tensor_parallel_size: tp, kv_cache_dtype: kv, max_model_len: NEEDS.context, gpu_memory_utilization: 0.9 });

/** The full-precision model fits for one conversation at a time: enough for a reference run, not for 16 people. */
export const reference: Grade[] = trialOf("skerry-32b, bf16, one conversation at a time", model("skerry-32b"), settings(2, "auto")).grades;
export const MATS_LOG: Trial[] = [
  trialOf("skerry-32b-awq · TP 2 · KV fp8", model("skerry-32b-awq"), settings(2, "fp8")),
  trialOf("skerry-32b-fp8 · TP 2 · KV auto", model("skerry-32b-fp8"), settings(2, "auto")),
  trialOf("skerry-32b-fp8 · TP 2 · KV fp8", model("skerry-32b-fp8"), settings(2, "fp8")),
];

// ---------------------------------------------------------------------------------------------
// The checks.

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.01);
const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

export async function runChecks(p: Planner) {
  const results: [boolean, string, string][] = [];
  const check = (name: string, fn: () => [boolean, string]) => {
    try {
      const [ok, detail] = fn();
      results.push([ok, name, detail]);
    } catch (e) {
      results.push([false, name, `crashed: ${(e as Error).message}`]);
    }
  };
  const goodSettings = settings(2, "fp8");
  const chosen = model("skerry-32b-fp8");

  // 1. The KV cache per token: 2 (a key and a value) x layers x KV heads x head size x bytes.
  check("Counts the KV cache, per token", () => {
    const cases: [Model, Settings][] = [[model("skerry-32b"), settings(2, "auto")], [model("skerry-14b"), settings(2, "auto")], [chosen, goodSettings]];
    const got = cases.map(([m, s]) => p.fit(m, s).kv_bytes_per_token);
    const want = cases.map(([m, s]) => trueFit(m, s).kvPerToken);
    const ok = got.every((g, i) => near(g, want[i]));
    return [ok, cases.map(([m, s], i) => `${m.id} KV ${s.kv_cache_dtype}: ${got[i]?.toLocaleString("en") ?? "?"} bytes`).join("; ") +
      ` (want ${want.map((w) => w.toLocaleString("en")).join(", ")})`];
  });

  // 2. The whole budget: every GPU's share, minus weights and overhead, then how many requests fit.
  check("Fits weights, overhead and KV cache in the budget", () => {
    const cases: [Model, Settings][] = [[model("skerry-32b-fp8"), settings(1, "fp8")], [model("skerry-32b-awq"), settings(2, "auto")], [model("skerry-14b"), settings(2, "auto")], [chosen, goodSettings]];
    const parts = cases.map(([m, s]) => {
      const g = p.fit(m, s), w = trueFit(m, s);
      const ok = near(g.max_concurrency, w.maxConcurrency) && g.fits === w.maxConcurrency >= NEEDS.concurrency && near(g.kv_room_gb, w.room / GB);
      return { ok, text: `${m.id} TP ${s.tensor_parallel_size} KV ${s.kv_cache_dtype}: ${fmt(g.max_concurrency)}x, ${g.fits ? "fits" : "doesn't fit"}` +
        ` (want ${fmt(w.maxConcurrency)}x, ${w.maxConcurrency >= NEEDS.concurrency ? "fits" : "doesn't fit"})` };
    });
    return [parts.every((x) => x.ok), parts.map((x) => x.text).join("; ")];
  });

  // 3. Mats runs exactly what you sized. Every setting you counted on must be on the command line.
  check("Boots with the settings you sized", () => {
    const srv = vllm(p.serveCommand(chosen, goodSettings));
    if ("error" in srv) return [false, `vllm refused to start: ${srv.error} (want it to start with TP 2, KV fp8, max_model_len ${NEEDS.context})`];
    const s = srv.settings;
    const same = JSON.stringify(s) === JSON.stringify(goodSettings);
    return [same && srv.max_concurrency >= NEEDS.concurrency,
      `started with TP ${s.tensor_parallel_size}, KV ${s.kv_cache_dtype}, max_model_len ${s.max_model_len}, utilization ${s.gpu_memory_utilization}; ` +
      `"${srv.log.at(-1)}" (want TP 2, KV fp8, max_model_len ${NEEDS.context}, 0.9, and at least ${NEEDS.concurrency}x)`];
  });

  // 4. The weights are already in the image. Nothing may reach for the hub, even by accident.
  check("Serves from the image, offline", () => {
    outbound.length = 0;
    const cmd = p.serveCommand(chosen, goodSettings);
    vllm(cmd);
    const ok = cmd.argv[2] === chosen.path && cmd.env?.HF_HUB_OFFLINE === "1" && outbound.length === 0;
    return [ok, `model ${cmd.argv[2]}, HF_HUB_OFFLINE=${cmd.env?.HF_HUB_OFFLINE ?? "(unset)"}, outbound attempts: ${outbound.length}` +
      `${outbound.length ? ` (${outbound[0]})` : ""} (want ${chosen.path}, HF_HUB_OFFLINE=1, and 0 attempts)`];
  });

  // 5. The agent asks for "torvik-support" and sends tools. The server must answer both.
  check("The agent's requests still work", () => {
    const srv = vllm(p.serveCommand(chosen, goodSettings));
    if ("error" in srv) return [false, `vllm refused to start: ${srv.error}`];
    const errors = goldenSet(srv).filter((g) => g.error);
    const first = errors[0];
    return [errors.length === 0, `${errors.length} of ${CASES.length * 3} golden-set requests failed` +
      `${first ? `; ${first.case_id}: ${first.error}` : ""} (want 0: the model name the agent asks for, and its tool calls)`];
  });

  // 6. Same average, different cases: quantization can move an error onto a number that matters.
  const verdicts = MATS_LOG.map((t) => ({ t, d: p.accept(reference, t) }));
  check("No case got worse", () => {
    const [awq, , good] = verdicts;
    const ok = !awq.d.ship && awq.d.regressions.join() === "T-07" && good.d.ship;
    return [ok, `${awq.t.label} -> ${awq.d.ship ? "ship" : "don't ship"} (regressions: ${awq.d.regressions.join(", ") || "none"}); ` +
      `${good.t.label} -> ${good.d.ship ? "ship" : "don't ship"} (want the first refused for T-07 alone, the second shipped)`];
  });

  // 7. Fast alone isn't fast. Read the latency at Torvik's peak.
  check("Fast enough at Torvik's peak", () => {
    const [, slow, good] = verdicts;
    const at = (t: Trial, n: number) => t.load.find((l) => l.concurrency === n)!.ttft_p95_s;
    const named = slow.d.reasons.some((r) => r.includes(String(NEEDS.concurrency)));
    const ok = !slow.d.ship && slow.d.regressions.length === 0 && named && good.d.ship;
    return [ok, `${slow.t.label} (p95 ${at(slow.t, 1)} s alone, ${at(slow.t, 16)} s at 16) -> ${slow.d.ship ? "ship" : `don't ship: ${slow.d.reasons.join("; ") || "no reason given"}`} ` +
      `(want refused, with a reason naming the ${NEEDS.concurrency} conversations)`];
  });

  for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  console.log(`\n${results.filter((r) => r[0]).length}/${results.length} checks pass.`);

  // The search Mats will sign off: smallest weights first. Your fit() picks the settings, your
  // serveCommand() starts the server, and your accept() decides.
  console.log("\nWhat your functions choose for gpu-01, smallest weights first:");
  const order = [...MODELS].sort((a, b) => a.weights_bytes - b.weights_bytes);
  let picked: string | undefined;
  for (const m of order) {
    let pick: { s: Settings; f: Fit } | undefined;
    for (const tp of [1, 2]) for (const kv of ["auto", "fp8"] as const) {
      const s = settings(tp, kv);
      let f: Fit;
      try { f = p.fit(m, s); } catch { continue; }
      if (!pick && f.fits) pick = { s, f };
    }
    if (!pick) {
      const best = trueFit(m, settings(2, "fp8"));
      console.log(`  ${m.id.padEnd(15)} doesn't fit: at best ${fmt(best.maxConcurrency)}x of ${NEEDS.concurrency} conversations (TP 2, KV fp8)`);
      continue;
    }
    const cmd = p.serveCommand(m, pick.s);
    const srv = vllm(cmd);
    const tag = `TP ${pick.s.tensor_parallel_size} · KV ${pick.s.kv_cache_dtype}`;
    if ("error" in srv) { console.log(`  ${m.id.padEnd(15)} ${tag}: vllm refused to start: ${srv.error.slice(0, 90)}…`); continue; }
    const t: Trial = { label: `${m.id} · ${tag}`, grades: goldenSet(srv), load: loadTest(srv) };
    const d = p.accept(reference, t);
    console.log(`  ${m.id.padEnd(15)} ${tag}: ${d.ship ? "SHIP" : "no"}${d.reasons.length ? ` (${d.reasons.join("; ")})` : ""}`);
    if (d.ship) {
      picked = m.id;
      const f = pick.f;
      console.log(`\nMats's start-up command for gpu-01:\n  ${Object.entries(cmd.env ?? {}).map(([k, v]) => `${k}=${v} `).join("")}${cmd.argv.join(" ")}`);
      const need = (f.kv_bytes_per_token * NEEDS.context * NEEDS.concurrency) / GB;
      console.log(`  Memory, both GPUs: ${fmt(f.budget_gb)} GB budget = ${fmt(f.weights_gb)} GB weights + ${fmt(f.overhead_gb)} GB overhead` +
        ` + ${fmt(f.kv_room_gb)} GB left for the KV cache. ${NEEDS.concurrency} conversations of ${NEEDS.context.toLocaleString("en")} tokens need ${fmt(need)} GB of it.`);
      for (const line of srv.log) console.log(`  vllm: ${line}`);
      break;
    }
  }
  if (!picked) console.log("\nNothing to ship yet.");
}
