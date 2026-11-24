// Lesson 13 exercise: choose the model Torvik will run on its own GPUs, serve it, and prove it's good enough.
// Run: bun exercises/0013-inference/start.ts
//
// Your job: make every check print PASS. Read the top of harness.ts first: the GPUs, Torvik's needs,
// the four Skerry versions and their config.json fields.
import { AGENT, GB, GPUS, NEEDS, OVERHEAD_GB_PER_GPU, runChecks, type Command, type Decision, type Fit, type Grade, type Model, type Settings, type Trial } from "./harness.ts";

// "Two cards with 48 GB each is 96 GB. If the weights fit, the model fits."
function fit(m: Model, s: Settings): Fit {
  const weights_gb = m.weights_bytes / GB;
  const budget_gb = GPUS.count * GPUS.memory_gb;
  return {
    weights_gb, overhead_gb: 0, budget_gb, kv_bytes_per_token: 0,
    kv_room_gb: budget_gb - weights_gb, max_concurrency: Infinity, fits: weights_gb < budget_gb,
  };
}

// The command from the model card's quick start.
function serveCommand(m: Model, s: Settings): Command {
  return { argv: ["vllm", "serve", m.hub_id], env: {} };
}

// "If it scores at least as well, and it's fast, ship it."
function accept(reference: Grade[], trial: Trial): Decision {
  const rate = (g: Grade[]) => g.filter((x) => x.pass).length / g.length;
  const alone = trial.load.find((l) => l.concurrency === 1)!.ttft_p95_s;
  const ship = rate(trial.grades) >= rate(reference) && alone <= NEEDS.ttft_p95_s;
  return { ship, regressions: [], reasons: ship ? [] : ["scored lower, or too slow"] };
}

// TODO, in the order of the checks:
//   1. fit(): the KV cache needs, for every token, a key and a value in every layer:
//      2 x num_hidden_layers x num_key_value_heads x head_dim x bytes per value.
//      Bytes: 2 for kv_cache_dtype "auto" (the model's bfloat16), 1 for "fp8". Read the KV heads,
//      not num_attention_heads: these models share 8 KV heads between 40 attention heads.
//   2. fit(): vLLM may use gpu_memory_utilization of each GPU it runs on (tensor_parallel_size of
//      them). From that budget, take the weights (all of them, split across the GPUs) and
//      OVERHEAD_GB_PER_GPU for each GPU. What's left is the room for the KV cache. max_concurrency
//      is how many requests of max_model_len tokens fit in that room. fits: at least NEEDS.concurrency.
//   3. serveCommand(): put every setting you sized on the command line: --tensor-parallel-size,
//      --max-model-len, --kv-cache-dtype, --gpu-memory-utilization. Leave one out and vLLM uses its
//      default, not your plan.
//   4. serveCommand(): serve the folder in the image (m.path), not the hub id, and set HF_HUB_OFFLINE=1.
//   5. serveCommand(): the agent asks for the model by AGENT.model, and sends tools. Add
//      --served-model-name, --enable-auto-tool-choice, and --tool-call-parser with m.tool_call_parser.
//   6. accept(): a regression is a case that passed every run in the reference and fails any run
//      in the trial (Lesson 8). Any regression, or a failed request, means don't ship, whatever the average.
//   7. accept(): read the p95 time to first token at NEEDS.concurrency, not alone. Give a reason for
//      every refusal.
void [AGENT, OVERHEAD_GB_PER_GPU];

await runChecks({ fit, serveCommand, accept });
