import { describe, it, expect, beforeEach } from "vitest";
import { registry } from "../registry.js";
import { traceStorage } from "../tracker.js";
import { tk } from "../slice.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  registry.drain();
});

// ─── 1. Concurrent trace isolation ──────────────────────────────────────────

describe("separates traces for concurrent operations", () => {
  it("assigns a distinct traceId to each concurrent tk.track call", async () => {
    const mod = {
      work: async (n: number) => {
        await delay(5); // real async gap — ALS must hold context across it
        return n * 2;
      },
    };
    const wrapped = tk.slice("concurrent", mod);

    const [a, b] = await Promise.all([
      tk.track(() => wrapped.work(1)),
      tk.track(() => wrapped.work(2)),
    ]);

    expect(a).toBe(2);
    expect(b).toBe(4);

    // Two records, one per invocation — each tagged with its own traceId.
    const records = registry.drain().filter(([, , s]) => s === "concurrent");
    expect(records).toHaveLength(2);

    const [idA, idB] = records.map(([, id]) => id);
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);

    // Both should be valid v4 UUIDs.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(idA).toMatch(uuidRe);
    expect(idB).toMatch(uuidRe);
  });

  it("does not mix traceIds when slices are shared across concurrent traces", async () => {
    // Same wrapped module used by both traces — verifies the context comes
    // from ALS, not from the proxy or slice closure.
    const shared = tk.slice("shared", { ping: () => "pong" });

    await Promise.all([
      tk.track(() => shared.ping()),
      tk.track(() => shared.ping()),
    ]);

    const records = registry.drain().filter(([, , s]) => s === "shared");
    expect(records).toHaveLength(2);
    expect(records[0]![1]).not.toBe(records[1]![1]);
  });
});

// ─── 2. Context cleanup after completion ────────────────────────────────────

describe("cleans up context after completion", () => {
  it("getStore() is undefined once tk.track() resolves", async () => {
    const wrapped = tk.slice("cleanup", { fn: () => {} });

    await tk.track(() => wrapped.fn());

    // ALS context must not leak out of the run() boundary.
    expect(traceStorage.getStore()).toBeUndefined();
  });

  it("getStore() is undefined after a rejected track", async () => {
    const wrapped = tk.slice("reject", { boom: () => { throw new Error("fail"); } });

    await expect(
      tk.track(() => wrapped.boom()),
    ).rejects.toThrow("fail");

    expect(traceStorage.getStore()).toBeUndefined();
  });

  it("does not expose the outer context inside a nested tk.track call", async () => {
    let outerStore: ReturnType<typeof traceStorage.getStore>;
    let innerStore: ReturnType<typeof traceStorage.getStore>;

    await tk.track(async () => {
      outerStore = traceStorage.getStore();
      await tk.track(async () => {
        innerStore = traceStorage.getStore();
      });
    });

    expect(outerStore?.traceId).toBeDefined();
    expect(innerStore?.traceId).toBeDefined();
    expect(outerStore?.traceId).not.toBe(innerStore?.traceId);
  });
});

// ─── 3. Async/await boundary propagation ────────────────────────────────────

describe("handles async/await boundaries", () => {
  it("carries the same traceId across an await delay()", async () => {
    const wrapped = tk.slice("async-boundary", { step: () => "ok" });
    let capturedId: string | undefined;

    await tk.track(async () => {
      capturedId = traceStorage.getStore()?.traceId;
      await delay(10); // real timer — not a microtask — crosses the event loop
      wrapped.step();  // invoked after the await; ALS must still hold context
    });

    const records = registry.drain().filter(([, , s]) => s === "async-boundary");
    expect(records).toHaveLength(1);
    expect(records[0]![1]).toBe(capturedId);
  });

  it("carries context across multiple sequential awaits", async () => {
    const wrapped = tk.slice("multi-await", {
      a: () => "a",
      b: () => "b",
      c: () => "c",
    });

    let capturedId: string | undefined;

    await tk.track(async () => {
      capturedId = traceStorage.getStore()?.traceId;
      wrapped.a();
      await delay(5);
      wrapped.b();
      await delay(5);
      wrapped.c();
    });

    const records = registry.drain().filter(([, , s]) => s === "multi-await");
    expect(records).toHaveLength(3);

    // Every record — regardless of which await gap it crossed — must share
    // the same traceId that was active at the start of tk.track().
    for (const [, id] of records) {
      expect(id).toBe(capturedId);
    }
  });

  it("propagates context into Promise.all children", async () => {
    const wrapped = tk.slice("promise-all", {
      task: async (n: number) => { await delay(5); return n; },
    });

    let capturedId: string | undefined;

    await tk.track(async () => {
      capturedId = traceStorage.getStore()?.traceId;
      await Promise.all([
        wrapped.task(1),
        wrapped.task(2),
        wrapped.task(3),
      ]);
    });

    const records = registry.drain().filter(([, , s]) => s === "promise-all");
    expect(records).toHaveLength(3);

    for (const [, id] of records) {
      expect(id).toBe(capturedId);
    }
  });
});
