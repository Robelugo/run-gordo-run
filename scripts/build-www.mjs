// Builds www/, the copy of the web app that goes inside the native iOS app:
// the app's own files plus one bundled file with the native plugins' JavaScript.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const out = new URL('www/', root);
const path = (url) => fileURLToPath(url);

await rm(out, { recursive: true, force: true });
await mkdir(new URL('vendor/', out), { recursive: true });
for (const item of ['index.html', 'css', 'js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest']) {
  await cp(new URL(item, root), new URL(item, out), { recursive: true });
}
await build({
  entryPoints: [path(new URL('native/plugins.js', root))],
  bundle: true,
  format: 'esm',
  target: 'safari15',
  outfile: path(new URL('vendor/capacitor-plugins.js', out)),
  logLevel: 'warning',
});
console.log('www/ is ready');
