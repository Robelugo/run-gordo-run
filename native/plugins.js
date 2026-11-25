// Entry point for the native plugins used by the iOS app. `npm run ios:www`
// bundles this file (with the plugins' JavaScript halves) into
// www/vendor/capacitor-plugins.js, which js/native.js loads inside the app.
export { BleClient } from '@capacitor-community/bluetooth-le';
export { KeepAwake } from '@capacitor-community/keep-awake';
