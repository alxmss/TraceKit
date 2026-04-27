import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Project, SyntaxKind, Node } from "ts-morph";
import MagicString from "magic-string";
import { registry } from "./registry.js";

export interface DistillOptions {
  projectRoot: string;
  /**
   * Maps every sliceName that appears in the trace to its source file.
   * Paths may be absolute or relative to `projectRoot`.
   */
  sliceMap: Map<string, string>;
}

function resolvePath(filePath: string, projectRoot: string): string {
  return isAbsolute(filePath) ? filePath : join(projectRoot, filePath);
}

/**
 * Given source text and the set of function names/paths that were called,
 * replaces the body of every other function with `{ /* pruned *\/ }`.
 * Import statements, type aliases, and interfaces are left untouched.
 *
 * `calledPaths` contains relative paths with the sliceName prefix already
 * stripped — e.g. for `sliceName.db.query` it holds `"db.query"`.
 */
function pruneFunctions(source: string, calledPaths: Set<string>): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("_tracekit_.ts", source);
  const s = new MagicString(source);

  function overwriteBody(body: Node): void {
    s.overwrite(body.getStart(), body.getEnd(), "{ /* pruned */ }");
  }

  // ── Top-level function declarations ──────────────────────────────────────
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (!name || calledPaths.has(name)) continue;
    const body = fn.getBody();
    if (body) overwriteBody(body);
  }

  // ── Variable declarations: arrow functions and function expressions ───────
  for (const varDecl of sf.getVariableDeclarations()) {
    const name = varDecl.getName();
    if (calledPaths.has(name)) continue;

    const init = varDecl.getInitializer();
    if (!init) continue;

    const arrowFn = init.asKind(SyntaxKind.ArrowFunction);
    if (arrowFn) {
      const body = arrowFn.getBody();
      // Concise arrow bodies (`() => expr`) are skipped — only block bodies
      // (`() => { ... }`) can be replaced with `{ /* pruned */ }` in-place.
      if (body.getKind() === SyntaxKind.Block) overwriteBody(body);
      continue;
    }

    const fnExpr = init.asKind(SyntaxKind.FunctionExpression);
    if (fnExpr) {
      const body = fnExpr.getBody();
      if (body) overwriteBody(body);
    }
  }

  // ── Class methods ─────────────────────────────────────────────────────────
  for (const cls of sf.getClasses()) {
    const clsName = cls.getName() ?? "";
    for (const method of cls.getMethods()) {
      const methodName = method.getName();
      // Registry records constructors as "ClassName" (after stripping "new ").
      // Methods are recorded as "ClassName.methodName" or bare "methodName".
      if (
        calledPaths.has(`${clsName}.${methodName}`) ||
        calledPaths.has(methodName) ||
        calledPaths.has(clsName) // constructor
      ) {
        continue;
      }
      const body = method.getBody();
      if (body) overwriteBody(body);
    }
  }

  return s.toString();
}

/**
 * Reads the registry for `traceId`, locates each source file via `sliceMap`,
 * and returns a `Map<filePath, prunedSource>`.
 *
 * Uses `snapshot()` so the registry is not drained — the caller controls
 * when to drain.
 */
export async function distill(
  traceId: string,
  options: DistillOptions,
): Promise<Map<string, string>> {
  const { projectRoot, sliceMap } = options;

  const records = registry.snapshot().filter(([, id]) => id === traceId);

  // Group called relative paths by resolved file path.
  // Multiple slices can map to the same file — their called-path sets are merged.
  const calledByFile = new Map<string, Set<string>>();

  for (const [, , sliceName, fnPath] of records) {
    const rawFile = sliceMap.get(sliceName);
    if (!rawFile) continue;

    const filePath = resolvePath(rawFile, projectRoot);
    let paths = calledByFile.get(filePath);
    if (!paths) {
      paths = new Set<string>();
      calledByFile.set(filePath, paths);
    }

    // Strip "new " prefix (constructor calls), then strip "sliceName." prefix
    // to get the path relative to the module root.
    // "test-mod.a"           → "a"
    // "new test-mod.Counter" → "Counter"
    // "test-mod.db.query"    → "db.query"
    const withoutNew = fnPath.startsWith("new ") ? fnPath.slice(4) : fnPath;
    const relPath = withoutNew.slice(sliceName.length + 1);
    paths.add(relPath);
  }

  const result = new Map<string, string>();

  for (const [filePath, calledPaths] of calledByFile) {
    const source = await readFile(filePath, "utf8");
    result.set(filePath, pruneFunctions(source, calledPaths));
  }

  return result;
}
