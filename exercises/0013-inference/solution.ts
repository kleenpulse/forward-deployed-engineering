// Lesson 13: a worked solution. Try start.ts first.
// Run: bun exercises/0013-inference/solution.ts
import { AGENT, GB, GPUS, NEEDS, OVERHEAD_GB_PER_GPU, runChecks, type Command, type Decision, type Fit, type Grade, type Model, type Settings, type Trial } from "./harness.ts";

function fit(m: Model, s: Settings): Fit {
  const c = m.config;
  // A key and a value, in every layer, for every KV head. "auto" means the model's own dtype.
  const bytes = s.kv_cache_dtype === "fp8" ? 1 : 2;
  const kv_bytes_per_token = 2 * c.num_hidden_layers * c.num_key_value_heads * c.head_dim * bytes;

  const gpus = s.tensor_parallel_size;
  const budget_gb = s.gpu_memory_utilization * GPUS.memory_gb * gpus;
  const weights_gb = m.weights_bytes / GB; // split across the GPUs, but all of it is somewhere
  const overhead_gb = OVERHEAD_GB_PER_GPU * gpus;
  const kv_room_gb = budget_gb - weights_gb - overhead_gb;
  const max_concurrency = (kv_room_gb * GB) / (kv_bytes_per_token * s.max_model_len);
  return { weights_gb, overhead_gb, budget_gb, kv_bytes_per_token, kv_room_gb, max_concurrency, fits: max_concurrency >= NEEDS.concurrency };
}

function serveCommand(m: Model, s: Settings): Command {
  return {
    env: { HF_HUB_OFFLINE: "1" }, // the weights are in the image; never ask the hub
    argv: [
      "vllm", "serve", m.path,
      "--served-model-name", AGENT.model,
      "--tensor-parallel-size", String(s.tensor_parallel_size),
      "--max-model-len", String(s.max_model_len),
      "--kv-cache-dtype", s.kv_cache_dtype,
      "--gpu-memory-utilization", String(s.gpu_memory_utilization),
      "--enable-auto-tool-choice", "--tool-call-parser", m.tool_call_parser,
    ],
  };
}

/** case_id -> pass/fail of each run, in trial order. */
function byCase(grades: Grade[]): Map<string, boolean[]> {
  const m = new Map<string, boolean[]>();
  for (const g of [...grades].sort((a, b) => a.trial - b.trial)) m.set(g.case_id, [...(m.get(g.case_id) ?? []), g.pass]);
  return m;
}
const passHatK = (grades: Grade[]) => {
  const runs = [...byCase(grades).values()];
  return runs.filter((r) => r.every(Boolean)).length / runs.length;
};

function accept(reference: Grade[], trial: Trial): Decision {
  const reasons: string[] = [];
  const now = byCase(trial.grades);
  const regressions = [...byCase(reference)]
    .filter(([id, was]) => was.every(Boolean) && !(now.get(id)?.every(Boolean) ?? false))
    .map(([id]) => id)
    .sort();
  for (const id of regressions) reasons.push(`${id} passed every run before and fails now`);

  const failed = trial.grades.filter((g) => g.error);
  if (failed.length) reasons.push(`${failed.length} requests failed, e.g. ${failed[0].error}`);
  if (passHatK(trial.grades) < passHatK(reference)) reasons.push("fewer cases pass every run than before");

  const peak = trial.load.find((l) => l.concurrency === NEEDS.concurrency);
  if (!peak) reasons.push(`no load test at ${NEEDS.concurrency} conversations`);
  else if (peak.ttft_p95_s > NEEDS.ttft_p95_s)
    reasons.push(`p95 time to first token is ${peak.ttft_p95_s} s at ${NEEDS.concurrency} conversations (target ${NEEDS.ttft_p95_s} s)`);

  return { ship: reasons.length === 0, regressions, reasons };
}

await runChecks({ fit, serveCommand, accept });
