import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Project, SyntaxKind } from "ts-morph";
import type { TraceKitConfig } from "./config.js";

/**
 * Locates and loads `tracekit.config.{ts,js,mjs}` from `root`.
 * Resolution order: `.ts` (parsed statically via ts-morph, no compilation
 * required) → `.js` → `.mjs` (dynamically imported).
 * Returns `null` when no config file is found.
 */
export async function loadConfigFile(root: string): Promise<TraceKitConfig | null> {
  const tsPath  = join(root, "tracekit.config.ts");
  const jsPath  = join(root, "tracekit.config.js");
  const mjsPath = join(root, "tracekit.config.mjs");

  if (await fileExists(tsPath))  return extractFromTs(tsPath);
  if (await fileExists(jsPath))  return importModule(jsPath);
  if (await fileExists(mjsPath)) return importModule(mjsPath);
  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function importModule(filePath: string): Promise<TraceKitConfig | null> {
  try {
    const mod = await import(pathToFileURL(filePath).href) as Record<string, unknown>;
    const cfg = mod["default"] ?? mod;
    if (cfg && typeof cfg === "object" && "slices" in cfg) {
      return cfg as TraceKitConfig;
    }
  } catch { /* fall through to null */ }
  return null;
}

/**
 * Parses a `tracekit.config.ts` file with ts-morph and extracts the argument
 * passed to `defineConfig(...)` — no TypeScript compilation or process
 * execution required.
 *
 * Handles both export styles:
 *   export default defineConfig({ ... })
 *   export const config = defineConfig({ ... })
 */
function extractFromTs(filePath: string): TraceKitConfig | null {
  try {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const sf = project.addSourceFileAtPath(filePath);

    const configCall = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find(c => c.getExpression().getText() === "defineConfig");
    if (!configCall) return null;

    const objLit = configCall
      .getArguments()[0]
      ?.asKind(SyntaxKind.ObjectLiteralExpression);
    if (!objLit) return null;

    const config: TraceKitConfig = { slices: {} };

    // ── slices: { name: './path.ts', ... } ───────────────────────────────────
    const slicesObj = objLit
      .getProperty("slices")
      ?.asKind(SyntaxKind.PropertyAssignment)
      ?.getInitializer()
      ?.asKind(SyntaxKind.ObjectLiteralExpression);

    if (slicesObj) {
      for (const prop of slicesObj.getProperties()) {
        const pa = prop.asKind(SyntaxKind.PropertyAssignment);
        if (!pa) continue;
        const name = pa.getName();
        const val  = pa.getInitializer()
          ?.asKind(SyntaxKind.StringLiteral)
          ?.getLiteralValue();
        if (name && val) config.slices[name] = val;
      }
    }

    // ── outputDir: '.tracekit' ────────────────────────────────────────────────
    const outDirVal = objLit
      .getProperty("outputDir")
      ?.asKind(SyntaxKind.PropertyAssignment)
      ?.getInitializer()
      ?.asKind(SyntaxKind.StringLiteral)
      ?.getLiteralValue();
    if (outDirVal) config.outputDir = outDirVal;

    return config;
  } catch {
    return null;
  }
}
