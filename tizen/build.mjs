// Builds the Tizen app into app/: bundles src/main.js (with the extension's
// api.js and ads.js) into one classic script, since ES modules don't load
// from the app's file:// origin, and copies hls.js and the icon.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

await esbuild.build({
  absWorkingDir: here,
  entryPoints: ['src/main.js'],
  outfile: 'app/main.js',
  bundle: true,
  format: 'iife',
  target: 'chrome69', // Tizen 5.5 (2020 TVs) and newer
  logLevel: 'info',
});

mkdirSync(`${here}app/lib`, { recursive: true });
copyFileSync(`${root}lib/hls.min.js`, `${here}app/lib/hls.min.js`);
copyFileSync(`${root}icons/icon128.png`, `${here}app/icon.png`);
