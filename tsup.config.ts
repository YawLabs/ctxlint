import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node18',
    outDir: 'dist',
    clean: true,
    define: {
      __VERSION__: JSON.stringify(pkg.version),
    },
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: ['src/mcp/server.ts'],
    format: ['esm'],
    target: 'node18',
    outDir: 'dist/mcp',
    define: {
      __VERSION__: JSON.stringify(pkg.version),
    },
  },
]);
