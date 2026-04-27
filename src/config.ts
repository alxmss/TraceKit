export interface TraceKitConfig {
  /**
   * Maps slice names to their source file paths.
   * Paths may be absolute or relative to the project root.
   * @example { auth: './src/auth.ts', db: './src/db/index.ts' }
   */
  slices: Record<string, string>;
  /**
   * Directory where distilled output files are written.
   * @default '.tracekit'
   */
  outputDir?: string;
}

/**
 * Identity helper that provides TypeScript inference for config objects —
 * the same pattern as vite's `defineConfig`. The function body is just
 * `return config`; the value is in the type narrowing.
 *
 * @example
 * // tracekit.config.ts
 * import { defineConfig } from 'tracekit';
 * export default defineConfig({
 *   slices: { auth: './src/auth.ts' },
 *   outputDir: '.tracekit',
 * });
 */
export function defineConfig(config: TraceKitConfig): TraceKitConfig {
  return config;
}
