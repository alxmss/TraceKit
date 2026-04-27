import { defineConfig } from '@alxmss/tracekit';

export default defineConfig({
  slices: {
    math: './mock-app/mathService.ts',
  },
  outputDir: '.tracekit',
});
