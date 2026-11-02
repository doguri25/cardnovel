/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** Writes sw.js with this build's file list and a version that changes with the build. */
function serviceWorker(): Plugin {
  return {
    name: 'cardnovel-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html').sort();
      const version = 'cardnovel-' + createHash('sha256').update(files.join('|')).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./sw/sw.template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', JSON.stringify(version))
        .replace('__ASSETS__', JSON.stringify(files.map((f) => './' + f)));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist' },
  plugins: [serviceWorker()],
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
});
