# Run-Gordo-Run

A web app for phone or tablet that talks to a ProForm Carbon TLX treadmill over
Bluetooth: live speed, incline, time, distance, calories and pulse, plus
start / pause / stop and speed / incline control, workout programs, heart-rate
zones and a shareable report after each workout.

> **Unofficial.** This is an independent hobby project. It is not affiliated
> with, endorsed by or supported by iFIT or ProForm. "ProForm", "Carbon TLX" and
> "iFit" are trademarks of their owners and are used here only to say which
> equipment the app works with. It gives no access to iFit content or
> subscriptions and changes nothing on the treadmill; it sends the same control
> commands the official app sends. Use it at your own risk.

The treadmill speaks iFit's proprietary Bluetooth protocol. This app implements
it from the public reverse-engineering work of the
zwifit,
[QZ](https://github.com/cagnulein/qdomyos-zwift) and
[ianchi/ifit](https://github.com/ianchi/ifit) projects.

**Live app:** https://robelugo.github.io/run-gordo-run/ (add `?demo` to try it
without a treadmill). It is served by GitHub Pages from the `main` branch, so
`git push` publishes a new version within a minute or so.

## Run it

```
npm start        # serves the app on http://localhost:8080
npm test         # protocol + client tests against the built-in simulator
```

Open `http://localhost:8080/?demo` to try the interface with a simulated treadmill.
Add `&warp=6` to run the simulated treadmill's clock six times faster, which is
handy for watching a long program play out.

## Profiles

Several people can share one device. The round button with an initial at the
top opens "Who is running?": pick a person, or add one. Each person has their
own profile (and so their own zones, VO2 max and calories), workout history,
program speeds and cat; units, the unlock code and sounds are shared. With more
than one person the app asks who is running each time it opens, and a workout
is saved for whoever is selected when it ends. A profile is renamed or deleted
from its own form (Settings > Profile > Edit).

## Heart-rate programs

With a heart-rate strap linked, the "Heart-rate hold" programs change the speed
(or the incline, at a fixed walking speed) by themselves to keep the pulse on a
target. Pulse answers a change of pace slowly, so the controller is deliberately
cautious:

- small steps (at most 0.5 km/h or 1 % incline), at least 20 s apart going up
  and 12 s apart going down, taking the current trend into account;
- speed never goes above the Run speed set on the Programs screen;
- without a fresh pulse reading it never pushes harder, and after 30 s it eases
  back to the walking speed;
- a pulse 12 bpm over target gets one larger step down; 25 bpm over, or at the
  maximum heart rate, goes straight back to walking speed / flat;
- a change made by hand is kept and the controller carries on from it.

## Use it with the real treadmill

Web Bluetooth only works on `https://` pages or on `localhost`, and only in
some browsers:

| Device | Browser |
| --- | --- |
| Android phone / tablet | Chrome or Edge |
| Windows / Mac / Chromebook | Chrome or Edge |
| iPhone / iPad | Bluefy, a free browser from the App Store (Safari has no Web Bluetooth) |

Ways to get it onto the phone:

- **Quick test from this PC:** open `http://localhost:8080` in Chrome on the PC
  (it needs Bluetooth) and connect from there.
- **Android over USB (recommended):** turn on Developer options > USB debugging
  on the phone, plug it in, and run `npm run phone`. It opens the app in Chrome
  on the phone; choose menu > "Add to Home screen" > Install. The phone keeps
  its own copy from then on, so it works without the cable or the PC. Run the
  command again whenever the app is updated.
- **Permanent:** upload this folder to any static HTTPS host (GitHub Pages,
  Netlify, Cloudflare Pages). Then use "Add to Home screen" to install it.

Close the iFit app first: the treadmill accepts one Bluetooth connection at a time.

### iPhone and iPad

Safari, and every other ordinary browser on iOS, has no Web Bluetooth. The app
runs in [Bluefy](https://apps.apple.com/app/id1492822055), a free browser that
adds it. Bluefy only allows Bluetooth on `https://` pages, so the app has to be
on an HTTPS host (the "Permanent" option above); the PC's `localhost` or a
`192.168...` address will not do.

1. Install Bluefy from the App Store and allow it to use Bluetooth.
2. Open the app's `https://` address in Bluefy and tap Link.

The Carbon TLX unlock code is built in and tried first, so nothing has to be
entered. Differences from Android:

- Download shows the report as pictures: touch and hold one, then Save to Photos.
- There may be no offline copy, so the phone needs internet to open the app.
- If the screen locks, the app stops updating until it is unlocked again. When
  the browser cannot keep the screen awake, set Auto-Lock to a longer time.

## Native iOS app

The same app can be built as a real iPhone / iPad app, with no Bluefy needed.
It is the web app wrapped with [Capacitor](https://capacitorjs.com); inside the
wrapper, `js/native.js` swaps the browser's Bluetooth for the phone's own
(through `js/native-bluetooth.js` and the Capacitor Bluetooth plugin) and keeps
the screen on while a treadmill is linked. The Xcode project is in `ios/`.

Building needs a Mac with Xcode (free, from the App Store), Node 22 or later
and an Apple ID:

```
git clone https://github.com/Robelugo/run-gordo-run.git
cd run-gordo-run
npm install
npm run ios:sync     # copies the app into the Xcode project
npm run ios:open     # opens it in Xcode
```

Then, in Xcode:

1. Xcode > Settings > Accounts: add your Apple ID.
2. Click "App" in the left column, then the "App" target > Signing &
   Capabilities. Tick "Automatically manage signing" and pick your team. If
   Xcode says the bundle identifier is taken, change it there and in
   `capacitor.config.json` (`appId`).
3. Connect the iPad or iPhone by cable and unlock it. On the device, turn on
   Settings > Privacy & Security > Developer Mode (it restarts once).
4. Choose the device at the top of the Xcode window and press Run.
5. With a free Apple ID the first launch is blocked until you trust yourself on
   the device: Settings > General > VPN & Device Management.

A free Apple ID's install stops opening after 7 days (press Run again to renew
it); with the paid Apple Developer Program it lasts a year and can also be
shared through TestFlight. After changing the app, run `git pull`,
`npm install` and `npm run ios:sync`, then Run again.

`npm run ios:add` recreates `ios/` from scratch (delete the folder first); it
also applies `scripts/ios-setup.mjs`, which adds the Bluetooth and photo
permissions texts and the icon from `native/icon-1024.png`.

## Unlock codes

iFit equipment only accepts control commands after receiving a model-specific
36-byte code. The Carbon TLX code (taken from QZ's capture of the iFit app
talking to a PFTL90924C.7) is tried first and was confirmed on a real Carbon
TLX with firmware 0.1.06122017.0908; the generic codes for other models are
all rejected by it. The app remembers the code that works. If none works the app still
displays live data; a code captured from the iFit app (see ianchi/ifit
"activation discovery") can be pasted under Settings > Unlock code.

## Safety

The app is a remote control for a machine with a moving belt. Keep the safety
key clipped on. If Bluetooth drops, the treadmill carries on at its current
speed: stop it with its own buttons or the safety key.

## Layout

- `js/protocol.js` - framing, checksums, value encoding (no Bluetooth)
- `js/treadmill.js` - client: discovery, unlock, read/write, polling
- `js/bluetooth.js` - Web Bluetooth transport
- `js/native.js`, `js/native-bluetooth.js` - Bluetooth and screen-on inside the native iOS app
- `js/simulator.js` - fake treadmill speaking the same bytes (demo mode, tests)
- `js/codes.js` - known unlock codes
- `js/programs.js` - workout programs (presets, custom intervals, step runner)
- `js/hrcontrol.js` - heart-rate programs: changes speed or incline to hold a target pulse
- `js/session.js` - workout totals, chart samples and history
- `js/people.js` - the people sharing the device, and which settings are kept per person
- `js/heart.js` - direct link to a heart-rate strap (standard Heart Rate service)
- `js/fitness.js` - heart-rate zones, VO2 max, calories and fat estimates from the profile
- `js/report.js` - the post-workout report drawn as two shareable 1080x1350 images
- `js/cat.js` - the 3D cats on the belt (raw WebGL, no libraries)
- `js/hud.js` - gauges, chart drawing, number tweening, beeps and haptics
- `js/app.js`, `index.html`, `css/app.css` - the interface
