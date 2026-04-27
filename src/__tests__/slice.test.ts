import { describe, it, expect, beforeEach } from "vitest";
import { registry } from "../registry.js";
import { tk } from "../slice.js";

// ─── helpers ────────────────────────────────────────────────────────────────

// TraceRecord is now [timestamp, traceId, sliceName, fnPath]
function drain() {
  return registry.drain();
}

// drain() empties the buffer — call once, then filter. Never call twice in a test.
function paths(sliceName: string) {
  return drain()
    .filter(([, , s]) => s === sliceName)
    .map(([, , , p]) => p);
}

beforeEach(() => {
  registry.drain();
});

// ─── 1. Basic function tracking ─────────────────────────────────────────────

describe("basic function tracking", () => {
  it("records a top-level function call", async () => {
    const mod = { greet: (name: string) => `hello ${name}` };
    const wrapped = tk.slice("greet-mod", mod);

    const result = await tk.track(() => wrapped.greet("world"));

    expect(result).toBe("hello world");
    expect(paths("greet-mod")).toEqual(["greet-mod.greet"]);
  });

  it("records the call timestamp as a number", async () => {
    const mod = { noop: () => {} };
    const wrapped = tk.slice("ts-mod", mod);
    const before = Date.now();
    await tk.track(() => wrapped.noop());
    const after = Date.now();

    const [ts] = drain()[0]!;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("does not record primitive property access", async () => {
    const mod = { version: "1.0.0", noop: () => {} };
    const wrapped = tk.slice("prim-mod", mod);

    await tk.track(() => {
      void wrapped.version; // should not record
      wrapped.noop();       // should record
    });

    expect(paths("prim-mod")).toEqual(["prim-mod.noop"]);
  });

  it("records multiple calls in order", async () => {
    const mod = { a: () => 1, b: () => 2 };
    const wrapped = tk.slice("order-mod", mod);

    await tk.track(() => {
      wrapped.a();
      wrapped.b();
      wrapped.a();
    });

    expect(paths("order-mod")).toEqual([
      "order-mod.a",
      "order-mod.b",
      "order-mod.a",
    ]);
  });

  it("passes arguments and return values through transparently", async () => {
    const mod = { add: (x: number, y: number) => x + y };
    const wrapped = tk.slice("math", mod);
    const result = await tk.track(() => wrapped.add(3, 4));
    expect(result).toBe(7);
  });

  it("does NOT record calls made outside a tk.track() context", () => {
    const mod = { fn: () => "bare" };
    const wrapped = tk.slice("bare-mod", mod);

    const result = wrapped.fn(); // no tk.track wrapper

    expect(result).toBe("bare");
    expect(drain()).toHaveLength(0);
  });
});

// ─── 2. Deeply nested object tracking ───────────────────────────────────────

describe("nested object tracking", () => {
  it("tracks functions nested one level deep", async () => {
    const mod = { db: { query: () => [] } };
    const wrapped = tk.slice("nested", mod);

    await tk.track(() => wrapped.db.query());

    expect(paths("nested")).toEqual(["nested.db.query"]);
  });

  it("tracks functions nested multiple levels deep", async () => {
    const mod = { a: { b: { c: { fn: () => "deep" } } } };
    const wrapped = tk.slice("deep", mod);

    const result = await tk.track(() => wrapped.a.b.c.fn());

    expect(result).toBe("deep");
    expect(paths("deep")).toEqual(["deep.a.b.c.fn"]);
  });

  it("records the correct slice name for each slice independently", async () => {
    const modA = { fn: () => "a" };
    const modB = { fn: () => "b" };
    const wA = tk.slice("sliceA", modA);
    const wB = tk.slice("sliceB", modB);

    await tk.track(() => { wA.fn(); wB.fn(); });

    // drain() clears the buffer in one shot; filter after, not in two drain calls.
    const all = drain();
    const bySlice = (name: string) =>
      all.filter(([, , s]) => s === name).map(([, , , p]) => p);

    expect(bySlice("sliceA")).toEqual(["sliceA.fn"]);
    expect(bySlice("sliceB")).toEqual(["sliceB.fn"]);
  });
});

// ─── 3. Class constructor tracking ──────────────────────────────────────────

describe("class constructor tracking", () => {
  it("records `new ClassName()` via the construct trap", async () => {
    class Counter {
      count = 0;
      increment() { this.count++; }
    }

    const wrapped = tk.slice("classes", { Counter });

    await tk.track(() => new wrapped.Counter());

    expect(paths("classes")).toContain("new classes.Counter");
  });

  it("records both constructor and subsequent method calls", async () => {
    class Logger {
      lines: string[] = [];
      log(msg: string) { this.lines.push(msg); }
    }

    const wrapped = tk.slice("logger-mod", { Logger });

    await tk.track(() => new wrapped.Logger());

    const recorded = paths("logger-mod");
    expect(recorded).toContain("new logger-mod.Logger");
  });

  it("preserves instanceof after wrapping the constructor", async () => {
    class Point {
      constructor(public x: number, public y: number) {}
    }

    const wrapped = tk.slice("geo", { Point });
    let p!: Point;
    await tk.track(() => { p = new wrapped.Point(1, 2); });

    expect(p).toBeInstanceOf(Point);
    expect(p.x).toBe(1);
    expect(p.y).toBe(2);
  });
});

// ─── 4. Cycle safety ────────────────────────────────────────────────────────

describe("cycle safety", () => {
  it("does not stack overflow on a circular reference", async () => {
    type Circular = { name: string; self?: Circular; fn: () => string };
    const obj: Circular = { name: "root", fn: () => "ok" };
    obj.self = obj;

    const wrapped = tk.slice("cycle", obj);

    await expect(tk.track(() => wrapped.fn())).resolves.toBe("ok");
    expect(paths("cycle")).toEqual(["cycle.fn"]);
  });

  it("returns the same proxy for repeated access of a circular node", async () => {
    type Node = { next?: Node; tag: string };
    const a: Node = { tag: "a" };
    const b: Node = { tag: "b", next: a };
    a.next = b;

    const wrapped = tk.slice("circ2", a);

    // Traversing the cycle twice must not blow the stack.
    await tk.track(() => {
      expect(wrapped.next?.next?.tag).toBe("a");
    });
  });
});

// ─── 5. Type fidelity ───────────────────────────────────────────────────────

describe("type fidelity", () => {
  it("preserves the exact return type of slice<T>", async () => {
    interface UserRepo {
      findById(id: number): { id: number; name: string };
    }
    const impl: UserRepo = { findById: (id) => ({ id, name: "Alice" }) };
    const wrapped: UserRepo = tk.slice("repo", impl); // must compile as UserRepo

    const user = await tk.track(() => wrapped.findById(1));

    expect(user.id).toBe(1);
    expect(user.name).toBe("Alice");
  });

  it("passes Symbol-keyed property access through without recording", async () => {
    const sym = Symbol("tag");
    const mod = { [sym]: "hidden", fn: () => {} };
    const wrapped = tk.slice("sym-mod", mod as { fn: () => void });

    await tk.track(() => wrapped.fn());

    // Symbol key access produces no registry entry.
    expect(paths("sym-mod")).toEqual(["sym-mod.fn"]);
  });

  it("does not crash when a property getter throws", async () => {
    const obj = Object.defineProperty(
      {} as { boom?: unknown; fn: () => void },
      "boom",
      { get() { throw new Error("boom"); }, enumerable: true, configurable: true },
    ) as { boom?: unknown; fn: () => void };
    obj.fn = () => {};

    const wrapped = tk.slice("getter-mod", obj);

    await tk.track(() => {
      expect(() => void wrapped.boom).not.toThrow();
      wrapped.fn();
    });

    expect(paths("getter-mod")).toEqual(["getter-mod.fn"]);
  });
});

// ─── 6. Registry drain / snapshot ───────────────────────────────────────────

describe("registry", () => {
  it("drain clears the buffer", async () => {
    const w = tk.slice("drain-test", { fn: () => {} });
    await tk.track(() => w.fn());
    expect(drain().length).toBe(1);
    expect(drain().length).toBe(0);
  });

  it("snapshot does not clear the buffer", async () => {
    const w = tk.slice("snap-test", { fn: () => {} });
    await tk.track(() => w.fn());
    expect(registry.snapshot().length).toBe(1);
    expect(registry.snapshot().length).toBe(1);
  });

  it("onFlush is called synchronously on each record", async () => {
    const calls: string[] = [];
    registry.onFlush = ([, , s, p]) => calls.push(`${s}:${p}`);

    const w = tk.slice("flush-test", { fn: () => {} });
    await tk.track(() => { w.fn(); w.fn(); });

    registry.onFlush = undefined;
    expect(calls).toEqual([
      "flush-test:flush-test.fn",
      "flush-test:flush-test.fn",
    ]);
  });
});
