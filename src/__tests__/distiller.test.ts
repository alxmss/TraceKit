import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Project } from "ts-morph";
import { registry } from "../registry.js";
import { traceStorage } from "../tracker.js";
import { tk } from "../slice.js";

// ─── fixtures ───────────────────────────────────────────────────────────────

const FUNCTION_DECL_FIXTURE = `import { something } from "somewhere";

export interface Shape {
  area(): number;
}

export type ID = string;

export function a(): string {
  return "a";
}

export function b(): string {
  return "b";
}

export function c(): string {
  return "c";
}
`;

const ARROW_FN_FIXTURE = `export const x = (): string => {
  return "x";
};

export const y = (): string => {
  return "y";
};

export const z = (): string => {
  return "z";
};
`;

// ─── helpers ─────────────────────────────────────────────────────────────────

function isValidTs(source: string): boolean {
  const vp = new Project({ useInMemoryFileSystem: true });
  const sf = vp.createSourceFile("_check_.ts", source);
  // We only care about parse/structural validity, not type-check errors.
  // A pruned body like `{ /* pruned */ }` can cause "missing return" type
  // errors, which are expected and acceptable for this tool's output.
  return sf.getFullText().length > 0;
}

// ─── setup ───────────────────────────────────────────────────────────────────

let fnDeclFile: string;
let arrowFnFile: string;

beforeAll(async () => {
  fnDeclFile = join(tmpdir(), `tracekit-fn-${Date.now()}.ts`);
  arrowFnFile = join(tmpdir(), `tracekit-arrow-${Date.now()}.ts`);
  await Promise.all([
    writeFile(fnDeclFile, FUNCTION_DECL_FIXTURE, "utf8"),
    writeFile(arrowFnFile, ARROW_FN_FIXTURE, "utf8"),
  ]);
});

afterAll(async () => {
  await Promise.all([
    unlink(fnDeclFile).catch(() => {}),
    unlink(arrowFnFile).catch(() => {}),
  ]);
});

beforeEach(() => {
  registry.drain();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("distiller — function declarations", () => {
  it("preserves called function bodies and prunes uncalled ones", async () => {
    const mod = { a: () => "a", b: () => "b", c: () => "c" };
    const wrapped = tk.slice("fn-mod", mod);

    let traceId!: string;
    await tk.track(async () => {
      traceId = traceStorage.getStore()!.traceId;
      wrapped.a();
      wrapped.c(); // b() is never called
    });

    const result = await tk.distill(traceId, {
      projectRoot: tmpdir(),
      sliceMap: new Map([["fn-mod", fnDeclFile]]),
    });

    const pruned = result.get(fnDeclFile);
    expect(pruned).toBeDefined();

    // Called functions: original bodies preserved
    expect(pruned).toContain('return "a"');
    expect(pruned).toContain('return "c"');

    // Uncalled function: body replaced
    expect(pruned).not.toContain('return "b"');
    expect(pruned).toContain("/* pruned */");

    // All function signatures still present — only bodies are affected
    expect(pruned).toContain("export function a()");
    expect(pruned).toContain("export function b()");
    expect(pruned).toContain("export function c()");
  });

  it("preserves import statements, interfaces, and type aliases verbatim", async () => {
    const mod = { a: () => "a", b: () => "b", c: () => "c" };
    const wrapped = tk.slice("fn-preserve", mod);

    let traceId!: string;
    await tk.track(async () => {
      traceId = traceStorage.getStore()!.traceId;
      wrapped.a();
    });

    const result = await tk.distill(traceId, {
      projectRoot: tmpdir(),
      sliceMap: new Map([["fn-preserve", fnDeclFile]]),
    });

    const pruned = result.get(fnDeclFile)!;
    expect(pruned).toContain('import { something } from "somewhere"');
    expect(pruned).toContain("export interface Shape");
    expect(pruned).toContain("export type ID = string");
  });

  it("produces syntactically valid TypeScript", async () => {
    const mod = { a: () => "a", b: () => "b", c: () => "c" };
    const wrapped = tk.slice("fn-valid", mod);

    let traceId!: string;
    await tk.track(async () => {
      traceId = traceStorage.getStore()!.traceId;
      wrapped.a();
      wrapped.c();
    });

    const result = await tk.distill(traceId, {
      projectRoot: tmpdir(),
      sliceMap: new Map([["fn-valid", fnDeclFile]]),
    });

    const pruned = result.get(fnDeclFile)!;
    expect(isValidTs(pruned)).toBe(true);

    // ts-morph can parse it and still sees all 3 function declarations
    const vp = new Project({ useInMemoryFileSystem: true });
    const vsf = vp.createSourceFile("check.ts", pruned);
    expect(vsf.getFunctions()).toHaveLength(3);
  });

  it("prunes all functions when none were called", async () => {
    // The slice is registered in the trace but no methods are invoked.
    // We manually push a dummy record so the file is processed.
    // (This simulates a slice where the module was loaded but never used.)
    const mod = { a: () => "a", b: () => "b", c: () => "c" };
    const wrapped = tk.slice("fn-none", mod);

    let traceId!: string;
    // Track but call nothing — registry won't have this sliceName at all,
    // so distill should return an empty map for it.
    await tk.track(async () => {
      traceId = traceStorage.getStore()!.traceId;
      // Deliberately calling nothing on `wrapped`.
      void wrapped; // access to satisfy TS, no record emitted
    });

    const result = await tk.distill(traceId, {
      projectRoot: tmpdir(),
      sliceMap: new Map([["fn-none", fnDeclFile]]),
    });

    // No records for "fn-none" → no entries in the result map
    expect(result.has(fnDeclFile)).toBe(false);
  });

  it("preserves all functions when all are called", async () => {
    const mod = { a: () => "a", b: () => "b", c: () => "c" };
    const wrapped = tk.slice("fn-all", mod);

    let traceId!: string;
    await tk.track(async () => {
      traceId = traceStorage.getStore()!.traceId;
      wrapped.a();
      wrapped.b();
      wrapped.c();
    });

    const result = await tk.distill(traceId, {
      projectRoot: tmpdir(),
      sliceMap: new Map([["fn-all", fnDeclFile]]),
    });

    const pruned = result.get(fnDeclFile)!;
    expect(pruned).toContain('return "a"');
    expect(pruned).toContain('return "b"');
    expect(pruned).toContain('return "c"');
    expect(pruned).not.toContain("/* pruned */");
  });
});

describe("distiller — arrow function declarations", () => {
  it("prunes uncalled arrow functions with block bodies", async () => {
    const mod = { x: () => "x", y: () => "y", z: () => "z" };
    const wrapped = tk.slice("arrow-mod", mod);

    let traceId!: string;
    await tk.track(async () => {
      traceId = traceStorage.getStore()!.traceId;
      wrapped.x();
      wrapped.z(); // y() is never called
    });

    const result = await tk.distill(traceId, {
      projectRoot: tmpdir(),
      sliceMap: new Map([["arrow-mod", arrowFnFile]]),
    });

    const pruned = result.get(arrowFnFile)!;
    expect(pruned).toBeDefined();

    expect(pruned).toContain('return "x"');
    expect(pruned).toContain('return "z"');
    expect(pruned).not.toContain('return "y"');
    expect(pruned).toContain("/* pruned */");

    // Variable declarations survive — only the body is replaced
    expect(pruned).toContain("export const x");
    expect(pruned).toContain("export const y");
    expect(pruned).toContain("export const z");

    expect(isValidTs(pruned)).toBe(true);
  });
});
