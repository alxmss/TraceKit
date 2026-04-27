import { writeFile } from "node:fs/promises";
import { tk, registry, traceStorage } from "./src/index.js";

// Runtime stubs — these match the shape of mathService.ts so the Proxy
// records the correct slice paths without needing to import the TS source.
const mathService = {
  add: (a: number, b: number): number => a + b,
  subtract: (a: number, b: number): number => a - b,
  complexMatrixMultiply: (_a: number[][], _b: number[][]): number[][] => {
    throw new Error("complexMatrixMultiply should never be called in this trace");
  },
};

const math = tk.slice("math", mathService);

let traceId!: string;

await tk.track(async () => {
  traceId = traceStorage.getStore()!.traceId;

  const sum = math.add(3, 7);
  const diff = math.subtract(10, 4);

  console.log(`add(3, 7)      = ${sum}`);        // 10
  console.log(`subtract(10, 4) = ${diff}`);      // 6
  // complexMatrixMultiply is deliberately never called
});

const records = registry.drain();

await writeFile("trace.json", JSON.stringify(records, null, 2), "utf8");

console.log(`\nTrace ID : ${traceId}`);
console.log(`Records  : ${records.length}`);
console.log(`Written  : trace.json`);
console.log(`\nNext step:`);
console.log(
  `  node dist/cli.js distill ${traceId} --trace trace.json --root . --map math=mock-app/mathService.ts`,
);
