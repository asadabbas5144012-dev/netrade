// Capacitor config for the NETRONTRADE Android app.
//
// The app is a thin native shell that loads the deployed NETRONTRADE server
// (server.url). Same-origin loading means the relative /api/... calls, socket.io
// and cookies in frontend/app.js work unchanged, and no API secret ever ships
// in the APK. www/ is only the offline fallback page + a bundled copy of the
// public frontend; it never contains the admin panel or any server code.
//
// The server URL is configurable at build time:
//   NETRONTRADE_APP_URL=https://your-domain npx cap sync android
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const DEFAULT_URL = 'https://netrontrade.onrender.com';
const appUrl = (process.env.NETRONTRADE_APP_URL || DEFAULT_URL).trim().replace(/\/+$/, '');

let host;
try {
  const u = new URL(appUrl);
  host = u.hostname;
  if (u.protocol !== 'https:') throw new Error('must use https');
} catch (e) {
  throw new Error(`NETRONTRADE_APP_URL "${appUrl}" is invalid: ${e.message}`);
}
// Refuse to build an APK that would point at a dev machine.
if (/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(host) || host === '10.0.2.2') {
  throw new Error(`NETRONTRADE_APP_URL must be the public production URL, not a local address (${host}).`);
}

/** @type {import('@capacitor/cli').CapacitorConfig} */
module.exports = {
  appId: 'com.netrontrade.app',
  appName: 'NETRONTRADE',
  webDir: 'www',
  server: {
    url: appUrl,
    cleartext: false,
    errorPath: 'offline.html',
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
    backgroundColor: '#050505',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: '#050505',
      showSpinner: false,
    },
  },
};
