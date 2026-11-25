// Glue for the native iOS app (the web app wrapped with Capacitor). Imported first
// by app.js. In an ordinary browser none of this does anything.
//
// Inside the native app the web view has no Web Bluetooth, so this installs a
// look-alike backed by the native Bluetooth plugin before the rest of the app
// starts, and offers a way to keep the screen on during a workout.

export const isNativeApp = !!globalThis.Capacitor?.isNativePlatform?.();

/** Set when the native plugins could not be loaded; shown to the user by app.js. */
export let nativeError = null;

let keepAwakePlugin = null;

export const nativeScreen = {
  on: () => keepAwakePlugin?.keepAwake().catch(() => {}),
  off: () => keepAwakePlugin?.allowSleep().catch(() => {}),
};

/** The in-app device list: fills as devices are found, resolves with the one tapped (or null). */
export function chooseDevice({ start, options }) {
  const $ = (id) => document.getElementById(id);
  const forStrap = (options.filters ?? []).some((f) => (f.services ?? []).some((s) => String(s).toLowerCase().startsWith('0000180d')));
  return new Promise((resolve) => {
    const dialog = $('devicePicker');
    const list = $('pickerList');
    const hint = $('pickerHint');
    list.replaceChildren();
    hint.classList.remove('error');
    $('pickerTitle').textContent = forStrap ? 'Heart rate strap' : 'Treadmill';
    hint.textContent = forStrap
      ? 'Searching. Wear the strap so it switches on.'
      : 'Searching. The treadmill must be switched on, and not linked to another phone or the iFit app.';
    let done = false;
    const finish = (device) => {
      if (done) return;
      done = true;
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      resolve(device);
    };
    const onClose = () => finish(null);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    start((device) => {
      if (done) return;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.innerHTML = '<b></b><span class="dur"></span>';
      card.children[0].textContent = device.name;
      card.children[1].textContent = device.rssi === null ? '' : device.rssi > -60 ? 'Close' : device.rssi > -80 ? 'Near' : 'Far';
      card.addEventListener('click', () => finish(device));
      list.append(card);
    }).catch((err) => {
      hint.textContent = `Could not search for devices: ${err.message}. Check that Bluetooth is on and allowed for this app in Settings.`;
      hint.classList.add('error');
    });
  });
}

if (isNativeApp) {
  try {
    const [{ BleClient, KeepAwake }, { createBluetooth }] = await Promise.all([
      import('../vendor/capacitor-plugins.js'),
      import('./native-bluetooth.js'),
    ]);
    Object.defineProperty(navigator, 'bluetooth', { value: createBluetooth(BleClient, { choose: chooseDevice }), configurable: true });
    keepAwakePlugin = KeepAwake;
  } catch (err) {
    nativeError = err;
  }
}
