// ─── Core API ─────────────────────────────────────────────────────────────────
// The `tk` namespace bundles the full public surface in one import:
//   import { tk } from "tracekit";
//   tk.configure(config);
//   const repo = tk.autoSlice("repo", repoModule);  // config-aware
//   const auth = tk.slice("auth", authModule);       // explicit
//   await tk.track(() => repo.findById(1));
//   const pruned = await tk.distill(traceId, { projectRoot, sliceMap });
export { tk, slice, configure, autoSlice } from "./slice.js";

// ─── Individual exports (for tree-shaking / explicit imports) ─────────────────
export { track, traceStorage } from "./tracker.js";
export type { TraceContext } from "./tracker.js";

export { distill } from "./distiller.js";
export type { DistillOptions } from "./distiller.js";

export { registry } from "./registry.js";
export type { TraceRegistry, TraceRecord } from "./registry.js";

export { defineConfig } from "./config.js";
export type { TraceKitConfig } from "./config.js";
