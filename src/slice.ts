import { registry } from "./registry.js";
import { traceStorage, track } from "./tracker.js";
import { distill } from "./distiller.js";
import type { TraceKitConfig } from "./config.js";

// Tracks already-proxied objects to break circular references.
// WeakMap holds no strong reference, so entries are GC'd with their targets.
const seen = new WeakMap<object, object>();

function wrapFn(fn: Function, sliceName: string, path: string): Function {
  return new Proxy(fn, {
    apply(target, thisArg, args: unknown[]) {
      // Only record when executing inside a tk.track() context. Calls made
      // outside a trace are still passed through — they just aren't observed.
      const store = traceStorage.getStore();
      if (store !== undefined) {
        registry.record(store.traceId, sliceName, path);
      }
      return Reflect.apply(target, thisArg, args);
    },

    // Required for `new Class()` — without this trap, constructor calls
    // bypass the apply trap entirely and are never recorded.
    construct(target, args: unknown[], newTarget: Function) {
      const store = traceStorage.getStore();
      if (store !== undefined) {
        registry.record(store.traceId, sliceName, `new ${path}`);
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
}

function wrapObject<T extends object>(target: T, sliceName: string, path: string): T {
  const proxy = new Proxy(target, {
    get(obj, key, receiver) {
      // Skip Symbol-keyed properties: wrapping Symbol.iterator, Symbol.toPrimitive,
      // etc. as functions breaks iteration protocols and type coercion.
      if (typeof key === "symbol") {
        return Reflect.get(obj, key, receiver);
      }

      let raw: unknown;
      try {
        raw = Reflect.get(obj, key, receiver);
      } catch {
        // Private class fields (#field) throw TypeError when accessed through a
        // Proxy receiver. Try the target directly; if the getter itself throws
        // (e.g. a lazy-init getter that errors), return undefined rather than
        // crashing the caller.
        try {
          return (obj as Record<string, unknown>)[key];
        } catch {
          return undefined;
        }
      }

      return wrapValue(raw, sliceName, `${path}.${key}`);
    },
  });

  seen.set(target, proxy);
  return proxy;
}

function wrapValue(value: unknown, sliceName: string, path: string): unknown {
  if (typeof value === "function") {
    return wrapFn(value, sliceName, path);
  }

  if (value !== null && typeof value === "object") {
    const existing = seen.get(value as object);
    if (existing !== undefined) return existing;
    return wrapObject(value as object, sliceName, path);
  }

  // Primitives pass through unchanged — no proxy needed.
  return value;
}

/**
 * Wraps a module slice so that every function call within it is recorded in
 * the global TraceRegistry. The return type is identical to the input,
 * preserving all IntelliSense and JSDoc annotations.
 *
 * Recording only occurs inside a `tk.track()` context — calls made outside
 * are still executed normally but produce no registry entries.
 *
 * @param name   Stable identifier for this slice, e.g. `"auth"` or `"db.users"`
 * @param target The module object or namespace to instrument
 */
export function slice<T extends object>(name: string, target: T): T {
  return wrapObject(target, name, name);
}

// ─── Config-aware API ─────────────────────────────────────────────────────────

let activeConfig: TraceKitConfig | undefined;

/**
 * Sets the global TraceKit config, unlocking `tk.autoSlice`.
 * Call once during app startup, before any `autoSlice` calls.
 *
 * @example
 * import config from "./tracekit.config.js";
 * tk.configure(config);
 */
export function configure(config: TraceKitConfig): void {
  activeConfig = config;
}

/**
 * Like `tk.slice`, but looks the name up in the active config so the CLI can
 * auto-resolve slice→file mappings without requiring `--map` flags.
 *
 * Requires `tk.configure(config)` to have been called first.
 *
 * @throws if `configure` has not been called, or if `name` is not in `slices`.
 */
export function autoSlice<T extends object>(name: string, target: T): T {
  if (activeConfig === undefined) {
    throw new Error(
      `tk.autoSlice("${name}", ...) was called before tk.configure(config).\n` +
      `Import your config and call tk.configure(config) at startup.`,
    );
  }
  if (!(name in activeConfig.slices)) {
    throw new Error(
      `Slice "${name}" has no entry in the config's slices map.\n` +
      `Add it to tracekit.config.ts: slices: { "${name}": "./src/${name}.ts" }`,
    );
  }
  return slice(name, target);
}

export const tk = { slice, track, distill, configure, autoSlice };
