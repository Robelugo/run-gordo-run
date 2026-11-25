// Run once after `cap add ios` (npm run ios:add does it): gives the generated
// Xcode project the permissions and looks this app needs.
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const app = new URL('ios/App/App/', root);
const plistUrl = new URL('Info.plist', app);

if (!existsSync(plistUrl)) {
  console.error('ios/App/App/Info.plist not found. Run `npx cap add ios` first.');
  process.exit(1);
}

// key -> the plist value that follows it
const KEYS = {
  // Without this text iOS closes the app the moment it touches Bluetooth.
  NSBluetoothAlwaysUsageDescription: '<string>Run-Gordo-Run uses Bluetooth to control your treadmill and read your heart rate strap.</string>',
  // Needed for "Save to Photos" on a workout report image.
  NSPhotoLibraryAddUsageDescription: '<string>Lets you save workout report images to your photo library.</string>',
  // The app is dark everywhere, so keep the clock and battery icons light.
  UIUserInterfaceStyle: '<string>Dark</string>',
};

let plist = await readFile(plistUrl, 'utf8');
const end = plist.lastIndexOf('</dict>');
if (end < 0) throw new Error('Info.plist has no closing </dict>');
let added = '';
for (const [key, value] of Object.entries(KEYS)) {
  if (plist.includes(`<key>${key}</key>`)) continue;
  added += `\t<key>${key}</key>\n\t${value}\n`;
  console.log(`Info.plist: added ${key}`);
}
if (added) await writeFile(plistUrl, plist.slice(0, end) + added + plist.slice(end));
else console.log('Info.plist: nothing to add');

// App icon: one 1024x1024 picture; Xcode makes the other sizes.
const icon = new URL('native/icon-1024.png', root);
const iconSet = new URL('Assets.xcassets/AppIcon.appiconset/', app);
if (existsSync(icon) && existsSync(new URL('Contents.json', iconSet))) {
  const contents = JSON.parse(await readFile(new URL('Contents.json', iconSet), 'utf8'));
  const target = contents.images?.find((image) => image.filename)?.filename;
  if (target) {
    await copyFile(icon, new URL(target, iconSet));
    console.log(`App icon: replaced ${target}`);
  }
}
console.log(`iOS project ready: ${fileURLToPath(app)}`);
