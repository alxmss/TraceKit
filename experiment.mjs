/**
 * TraceKit Experiment — "Financial Ledger Hot Path"
 *
 * Simulates a payment-processing loop that uses only `add` and `subtract`
 * from mathService. complexMatrixMultiply exists in the module but is never
 * reached during this execution path — a realistic proxy for a large,
 * rarely-exercised function (e.g. a risk-model optimiser) that would bloat
 * context if included in an LLM prompt or code review.
 */
import { writeFile } from "node:fs/promises";
import { tk, registry, traceStorage, defineConfig } from "./dist/index.js";

// ── 1. Configure ────────────────────────────────────────────────────────────
const config = defineConfig({
  slices: { math: "./mock-app/mathService.ts" },
  outputDir: ".tracekit",
});
tk.configure(config);

// ── 2. Runtime module (mirrors the shape of mathService.ts) ─────────────────
const mathService = {
  add:      (a, b) => a + b,
  subtract: (a, b) => a - b,
  complexMatrixMultiply: (_a, _b) => {
    throw new Error("Cold path — should never appear in this trace");
  },
};

const math = tk.autoSlice("math", mathService);

// ── 3. Experiment: process a ledger of transactions ─────────────────────────
const transactions = [
  { type: "credit", amount: 1_200.00 },
  { type: "debit",  amount:   450.50 },
  { type: "credit", amount: 3_800.00 },
  { type: "debit",  amount: 2_100.75 },
  { type: "credit", amount:   650.25 },
  { type: "debit",  amount:    89.00 },
];

let traceId;
let balance = 0;

await tk.track(async () => {
  traceId = traceStorage.getStore().traceId;

  for (const tx of transactions) {
    if (tx.type === "credit") {
      balance = math.add(balance, tx.amount);
    } else {
      balance = math.subtract(balance, tx.amount);
    }
  }
});

// ── 4. Export trace ─────────────────────────────────────────────────────────
const records = registry.drain();
await writeFile("trace.json", JSON.stringify(records, null, 2), "utf8");

// ── 5. Report ────────────────────────────────────────────────────────────────
console.log("Experiment complete");
console.log(`  Final balance : $${balance.toFixed(2)}`);
console.log(`  Trace ID      : ${traceId}`);
console.log(`  Records       : ${records.length}`);
console.log(`  Functions hit : ${[...new Set(records.map(r => r[3]))].join(", ")}`);
console.log(`  Written       : trace.json`);
// Print bare traceId last so it can be captured by a subshell
process.stdout.write(traceId + "\n");
