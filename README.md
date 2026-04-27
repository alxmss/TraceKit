# TraceKit

Runtime instrumentation and deterministic source pruning for TypeScript.

TraceKit wraps your modules in a transparent Proxy, records which functions are called during an execution, and then rewrites your source files to remove every function body that was never touched — replacing them with `{ /* pruned */ }`. The result is a minimal, accurate picture of what your code actually does at runtime.

> **Status: Operational** — 34/34 tests passing.  
> Node.js 22+, TypeScript 5.x, ESM.

[![Tests](https://img.shields.io/badge/tests-34%20passing-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)]()
[![Node](https://img.shields.io/badge/Node.js-22%2B-green)]()

---

## How it works

```
your code  →  tk.slice()  →  Proxy  →  tk.track()  →  Registry
                                                            ↓
tracekit distill  ←  trace.json  ←  registry.drain()  ←  traceId
        ↓
  mathService.pruned.ts   (complexMatrixMultiply body gone, add/subtract intact)
```

1. **Slice** — wrap a module with `tk.slice(name, module)`. The return type is `T`, so IntelliSense and JSDoc are fully preserved.
2. **Track** — run your code inside `tk.track(fn)`. Every function call on a wrapped module is tagged with a unique trace ID and stored in the in-process registry.
3. **Drain** — export the registry to a JSON file with `registry.drain()`.
4. **Distill** — run the CLI against the JSON file. Functions that appear in the trace keep their bodies; everything else is pruned.

---

## Installation

### In a project that already has TypeScript

```bash
npm install --save-dev tracekit
```

Then initialise the config (this creates `tracekit.config.ts` and adds a helper script to `package.json`):

```bash
npx tracekit init
```

### From source (this repo)

```bash
git clone <repo>
cd TraceKit
npm install
npm run build        # compiles src/ → dist/
```

---

## Quick start

### 1. Initialise

```bash
npx tracekit init
```

This creates `tracekit.config.ts` in your project root and adds `trace:distill` to your `package.json` scripts.

### 2. Edit the config

Open `tracekit.config.ts` and map your slice names to their source files:

```ts
// tracekit.config.ts
import { defineConfig } from 'tracekit';

export default defineConfig({
  slices: {
    math:   './src/mathService.ts',
    auth:   './src/auth.ts',
    db:     './src/db/index.ts',
  },
  outputDir: '.tracekit',
});
```

### 3. Instrument your code

```ts
import { tk, registry, traceStorage } from 'tracekit';
import { writeFile } from 'node:fs/promises';
import * as mathService from './src/mathService.js';

// Option A — explicit (no config required)
const math = tk.slice('math', mathService);

// Option B — config-aware (reads sliceMap from tracekit.config.ts automatically)
import config from './tracekit.config.js';
tk.configure(config);
const math = tk.autoSlice('math', mathService);
```

### 4. Run a trace

```ts
let traceId!: string;

await tk.track(async () => {
  traceId = traceStorage.getStore()!.traceId;

  // Only call the functions you actually need right now
  math.add(3, 7);
  math.subtract(10, 4);
  // math.complexMatrixMultiply is never called → will be pruned
});

// Export the trace
const records = registry.drain();
await writeFile('trace.json', JSON.stringify(records), 'utf8');
console.log('Trace ID:', traceId);
```

### 5. Distill

```bash
# Auto-resolves slice→file from tracekit.config.ts
npx tracekit distill <traceId> --trace trace.json --root .

# Or print as markdown (useful for LLM context)
npx tracekit distill <traceId> --trace trace.json --root . --format md

# Or write to a directory
npx tracekit distill <traceId> --trace trace.json --root . --output .tracekit
```

**Input** (`src/mathService.ts`):

```ts
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function complexMatrixMultiply(a: number[][], b: number[][]): number[][] {
  // ... 30 lines of O(n³) loops ...
}
```

**Output** (distilled):

```ts
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function complexMatrixMultiply(a: number[][], b: number[][]): number[][] { /* pruned */ }
```

---

## API reference

### `tk.slice<T>(name, module): T`

Wraps a module in a transparent Proxy. The return type is exactly `T` — no type information is lost. Recording only happens inside a `tk.track()` context; calls made outside are passed through without being observed.

```ts
const auth = tk.slice('auth', authModule);
```

### `tk.configure(config)`

Sets the global config so that `tk.autoSlice` knows the slice→file mapping. Call once at startup before any `autoSlice` calls.

```ts
import config from './tracekit.config.js';
tk.configure(config);
```

### `tk.autoSlice<T>(name, module): T`

Like `tk.slice`, but validates that `name` is registered in the config. The CLI reads the same config file, so you never need to pass `--map` on the command line.

```ts
const db = tk.autoSlice('db', dbModule);
```

### `tk.track<T>(fn: () => T | Promise<T>): Promise<T>`

Runs `fn` inside a new trace context backed by `AsyncLocalStorage`. Every function call on a sliced module within `fn` — including across `await` boundaries — is tagged with the same `traceId`. Concurrent `tk.track()` calls never share a context.

```ts
const result = await tk.track(async () => {
  const user = await userRepo.findById(42);
  return user;
});
```

### `tk.distill(traceId, options): Promise<Map<string, string>>`

Programmatic distillation. Reads the registry for `traceId`, looks up source files via `sliceMap`, and returns a `Map<filePath, prunedSource>`. Does not drain the registry.

```ts
const pruned = await tk.distill(traceId, {
  projectRoot: process.cwd(),
  sliceMap: new Map([['auth', './src/auth.ts']]),
});
```

### `registry`

The global in-process ring buffer (10 000 records by default, configurable via `TRACEKIT_MAX_RECORDS`).

| Method | Description |
|--------|-------------|
| `registry.drain()` | Returns all records and clears the buffer |
| `registry.snapshot()` | Returns all records without clearing |
| `registry.onFlush` | Optional callback fired synchronously on every `record()` call |

Each record is a tuple `[timestamp, traceId, sliceName, fnPath]`.

### `defineConfig(config): TraceKitConfig`

Identity helper with TypeScript type inference — the same pattern as Vite's `defineConfig`. Use it in `tracekit.config.ts` for editor autocomplete.

---

## CLI reference

### `tracekit init`

Scaffolds `tracekit.config.ts` in the project root and patches `package.json`.

```
Options:
  --root <path>   project root (default: current directory)
  --force         overwrite an existing tracekit.config.ts
```

### `tracekit distill <traceId>`

Prunes source files based on a recorded trace.

```
Options:
  --trace <file>     JSON file from registry.drain() (use "-" for stdin)
  --root <path>      project root (required)
  --map <name=path>  slice → file mapping, repeatable; overrides tracekit.config.ts
  --output <dir>     write pruned files here instead of printing to stdout
  --format <fmt>     text (default) or md
```

When `--map` is omitted, the CLI auto-resolves the mapping from `tracekit.config.ts` at `--root`.

When `--format md` and `--output` are both set, all files are combined into a single `<traceId>.md` file — useful for pasting into an LLM prompt.

---

## Edge cases and known behaviour

| Scenario | Behaviour |
|----------|-----------|
| Calls made outside `tk.track()` | Executed normally, not recorded |
| Circular references | Safe — a `WeakMap` breaks cycles |
| `new ClassName()` | Recorded as `new sliceName.ClassName` via `construct` trap |
| Private class fields (`#field`) | Passed through without interception |
| Symbol-keyed properties | Passed through; wrapping `Symbol.iterator` would break iteration |
| Arrow functions with concise bodies | Bodies like `() => expr` are not pruned (no block to replace) |
| Concurrent `tk.track()` calls | Each gets its own `traceId`; `AsyncLocalStorage` keeps them isolated |

---

## Development

```bash
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm test             # vitest run (34 tests)
npm run test:watch   # vitest interactive
npm run typecheck    # tsc --noEmit (no emit, just type-check)
```

---

## Project structure

```
src/
  registry.ts       Ring-buffer record store
  tracker.ts        AsyncLocalStorage context (traceId per tk.track call)
  slice.ts          Proxy engine + tk namespace
  distiller.ts      ts-morph AST parser + magic-string body replacer
  config.ts         defineConfig helper and TraceKitConfig interface
  config-loader.ts  CLI-side static parser for tracekit.config.ts
  cli.ts            Commander CLI (init, distill)
  index.ts          Public API surface
  __tests__/
    slice.test.ts
    tracker.test.ts
    distiller.test.ts
```
