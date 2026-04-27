#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, join, basename, extname } from "node:path";
import { Command } from "commander";
import { registry } from "./registry.js";
import { distill } from "./distiller.js";
import { loadConfigFile } from "./config-loader.js";
import type { TraceRecord } from "./registry.js";

// ─── validation ──────────────────────────────────────────────────────────────

function isTraceRecord(v: unknown): v is TraceRecord {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    typeof v[0] === "number" &&
    typeof v[1] === "string" &&
    typeof v[2] === "string" &&
    typeof v[3] === "string"
  );
}

// ─── I/O helpers ─────────────────────────────────────────────────────────────

async function readJson(filePath: string): Promise<unknown> {
  if (filePath === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

function parseSliceMap(entries: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq === -1) die(`Invalid --map entry "${entry}" — expected format: name=./path/to/file.ts`);
    map.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return map;
}

function die(msg: string): never {
  process.stderr.write(`tracekit: ${msg}\n`);
  process.exit(1);
}

function collectRepeatable(value: string, acc: string[]): string[] {
  return [...acc, value];
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// ─── output formatters ────────────────────────────────────────────────────────

function formatText(filePath: string, content: string): string {
  return `// ── ${filePath} ──\n${content}\n`;
}

function formatMd(filePath: string, content: string): string {
  return `## ${filePath}\n\n\`\`\`typescript\n${content}\n\`\`\`\n`;
}

// ─── config template (written by `tracekit init`) ────────────────────────────

const CONFIG_TEMPLATE = `import { defineConfig } from 'tracekit';

export default defineConfig({
  slices: {
    // Map every slice name to its source file:
    // 'myService': './src/myService.ts',
  },
  outputDir: '.tracekit',
});
`;

// ─── CLI definition ───────────────────────────────────────────────────────────

const program = new Command();

program
  .name("tracekit")
  .description("Runtime instrumentation and source pruning for TypeScript")
  .version("0.1.0");

// ── init ─────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Scaffold tracekit.config.ts and add a trace:distill script to package.json")
  .option("--root <path>", "project root (default: current directory)", ".")
  .option("--force", "overwrite an existing tracekit.config.ts", false)
  .action(async (opts: { root: string; force: boolean }) => {
    const root       = resolve(opts.root);
    const configPath = join(root, "tracekit.config.ts");
    const pkgPath    = join(root, "package.json");

    // ── 1. Write tracekit.config.ts ─────────────────────────────────────────
    if (!opts.force && await fileExists(configPath)) {
      die(`tracekit.config.ts already exists — use --force to overwrite`);
    }
    await writeFile(configPath, CONFIG_TEMPLATE, "utf8");
    process.stdout.write(`✔ Created:  ${configPath}\n`);

    // ── 2. Update package.json ───────────────────────────────────────────────
    if (await fileExists(pkgPath)) {
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Record<string, unknown>;
      } catch {
        process.stderr.write(`tracekit: warning — could not parse package.json\n`);
        pkg = {};
      }

      let changed = false;

      // Add trace:distill convenience script
      const scripts = (pkg["scripts"] ?? {}) as Record<string, string>;
      if (!scripts["trace:distill"]) {
        scripts["trace:distill"] = "tracekit distill --trace trace.json --root .";
        pkg["scripts"] = scripts;
        changed = true;
      }

      // Mock devDependency registration (real install is out-of-scope for init)
      const devDeps = (pkg["devDependencies"] ?? {}) as Record<string, string>;
      if (!devDeps["tracekit"]) {
        devDeps["tracekit"] = "^0.1.0";
        pkg["devDependencies"] = devDeps;
        changed = true;
      }

      if (changed) {
        await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
        process.stdout.write(`✔ Updated:  ${pkgPath}\n`);
      } else {
        process.stdout.write(`  Skipped:  ${pkgPath} (already configured)\n`);
      }
    } else {
      process.stdout.write(`  Skipped:  package.json not found\n`);
    }

    process.stdout.write(`
Next steps:
  1. Edit tracekit.config.ts — add your slice → file mappings
  2. In your app, call tk.configure(config) then tk.autoSlice(name, module)
  3. After a traced run: node dist/cli.js distill <traceId> --trace trace.json --root .
     (or: npm run trace:distill -- <traceId>)
`);
  });

// ── distill ───────────────────────────────────────────────────────────────────

program
  .command("distill <traceId>")
  .description("Prune source files to only the functions executed in a recorded trace")
  .requiredOption(
    "--trace <file>",
    'JSON file produced by registry.drain() — use "-" to read from stdin',
  )
  .requiredOption(
    "--root <path>",
    "project root for resolving relative paths and locating tracekit.config.ts",
  )
  .option(
    "--map <name=path>",
    "slice → file mapping, repeatable (overrides tracekit.config.ts when provided)",
    collectRepeatable,
    [] as string[],
  )
  .option(
    "--output <dir>",
    "write pruned files to this directory instead of printing to stdout",
  )
  .option(
    "--format <fmt>",
    "output format: text (default) or md (wraps each file in a markdown code block)",
    "text",
  )
  .action(async (traceId: string, opts: {
    trace: string;
    root: string;
    map: string[];
    output?: string;
    format: string;
  }) => {
    const projectRoot = resolve(opts.root);

    // ── 1. Load and validate trace records ──────────────────────────────────
    let raw: unknown;
    try {
      raw = await readJson(opts.trace);
    } catch {
      die(`Could not read trace file "${opts.trace}"`);
    }

    if (!Array.isArray(raw)) die("Trace file must contain a JSON array of TraceRecord tuples");

    const matched: TraceRecord[] = [];
    for (const item of raw) {
      if (!isTraceRecord(item)) {
        process.stderr.write(`tracekit: warning — skipping malformed record: ${JSON.stringify(item)}\n`);
        continue;
      }
      if (item[1] === traceId) matched.push(item);
    }

    if (matched.length === 0) die(`No records found for traceId "${traceId}"`);

    // ── 2. Populate the in-process registry ─────────────────────────────────
    // distill() reads from registry.snapshot(). The timestamp is regenerated
    // here (Date.now()), which is acceptable — distill() only uses the path fields.
    for (const [, tid, sliceName, fnPath] of matched) {
      registry.record(tid, sliceName, fnPath);
    }

    // ── 3. Resolve the slice → file map ─────────────────────────────────────
    let sliceMap: Map<string, string>;

    if (opts.map.length > 0) {
      // Explicit --map flags always win over config file
      sliceMap = parseSliceMap(opts.map);
    } else {
      // Auto-resolve from tracekit.config.ts (or .js / .mjs)
      const config = await loadConfigFile(projectRoot);
      if (!config || Object.keys(config.slices).length === 0) {
        die(
          "No --map entries provided and no tracekit.config.ts found.\n" +
          "  Run 'tracekit init' to scaffold a config, or pass --map auth=src/auth.ts",
        );
      }
      sliceMap = new Map(Object.entries(config.slices));
      process.stderr.write(
        `Auto-resolved ${sliceMap.size} slice(s) from tracekit.config.ts\n`,
      );
    }

    // ── 4. Run the distiller ─────────────────────────────────────────────────
    let result: Map<string, string>;
    try {
      result = await distill(traceId, { projectRoot, sliceMap });
    } catch (err) {
      die(err instanceof Error ? err.message : String(err));
    }

    if (result.size === 0) {
      die("Distiller produced no output — verify your slice names match the recorded trace");
    }

    const fmt = opts.format === "md" ? formatMd : formatText;

    // ── 5. Output ─────────────────────────────────────────────────────────────
    if (opts.output) {
      const outDir = resolve(opts.output);
      await mkdir(outDir, { recursive: true });

      if (opts.format === "md") {
        // Single .md file combining all pruned files as sections
        const sections = [...result.entries()]
          .map(([fp, src]) => fmt(fp, src))
          .join("\n");
        const dest = join(outDir, `${traceId}.md`);
        await writeFile(dest, sections, "utf8");
        process.stdout.write(`Written: ${dest}\n`);
      } else {
        // One .pruned.ts file per source file
        for (const [filePath, content] of result) {
          const ext  = extname(filePath);
          const name = `${basename(filePath, ext)}.pruned${ext}`;
          const dest = join(outDir, name);
          await writeFile(dest, content, "utf8");
          process.stdout.write(`Written: ${dest}\n`);
        }
      }
    } else {
      for (const [filePath, content] of result) {
        process.stdout.write(fmt(filePath, content) + "\n");
      }
    }
  });

program.parse();
