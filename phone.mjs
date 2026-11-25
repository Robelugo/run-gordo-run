// `npm run phone`: put the app on an Android phone connected over USB.
// Forwards the phone's localhost:8080 to this PC, opens Chrome there, and serves the app.
// After the first load the phone keeps its own copy, so the cable and PC are no longer needed.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.PORT) || 8080;
const candidates = [
  process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'adb',
].filter(Boolean);
const adb = candidates.find((path) => path === 'adb' || existsSync(path));
const run = (...args) => execFileSync(adb, args, { encoding: 'utf8' });

let devices;
try {
  devices = run('devices')
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([id]) => id);
} catch {
  console.error('Could not run adb. Install Android platform-tools or use chrome://inspect port forwarding instead.');
  process.exit(1);
}

const ready = devices.filter(([, state]) => state === 'device');
if (!ready.length) {
  const waiting = devices.some(([, state]) => state === 'unauthorized');
  console.error(
    waiting
      ? 'The phone is connected but has not allowed this PC yet. Unlock it and accept the "Allow USB debugging?" prompt, then run this again.'
      : 'No phone found. Plug it in with a USB cable and turn on Settings > Developer options > USB debugging, then run this again.',
  );
  process.exit(1);
}

run('reverse', `tcp:${port}`, `tcp:${port}`);
await import('./server.mjs');
try {
  run('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `http://localhost:${port}/`, 'com.android.chrome');
  console.log('Opened the app in Chrome on the phone.');
} catch {
  console.log(`Open http://localhost:${port}/ in Chrome on the phone.`);
}
console.log('In Chrome: menu (three dots) > "Add to Home screen" > Install. Then you can unplug the phone and press Ctrl+C here.');
