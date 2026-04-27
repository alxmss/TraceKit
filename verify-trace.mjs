// Runnable companion to verify-trace.ts — imports from the compiled dist/
import { writeFile } from "node:fs/promises";
import { tk, registry, traceStorage } from "./dist/index.js";

const mathService = {
  add:      (a, b) => a + b,
  subtract: (a, b) => a - b,
  complexMatrixMultiply: (_a, _b) => {
    throw new Error("complexMatrixMultiply must never be called in this trace");
  },
};

const math = tk.slice("math", mathService);

let traceId;

await tk.track(async () => {
  traceId = traceStorage.getStore().traceId;

  const sum  = math.add(3, 7);
  const diff = math.subtract(10, 4);

  console.log(`add(3, 7)       = ${sum}`);
  console.log(`subtract(10, 4) = ${diff}`);
  // complexMatrixMultiply deliberately never called
});

const records = registry.drain();
await writeFile("trace.json", JSON.stringify(records, null, 2), "utf8");

console.log(`\nTrace ID : ${traceId}`);
console.log(`Records  : ${records.length}`);
console.log(`Written  : trace.json`);
