import { defineConfig } from 'tracekit';

export default defineConfig({
  slices: {
    math: './mock-app/mathService.ts',
  },
  outputDir: '.tracekit',
});
