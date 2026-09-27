/**
 * "Web build" for the Android shell: copies ONLY the public frontend files into
 * www/ (the Capacitor webDir). The admin panel (secure_admin_panel.html) and any
 * server code are deliberately never copied into the APK.
 *
 * Run: node scripts/build-web.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'frontend');
const OUT = path.join(ROOT, 'www');

// Keep in sync with PUBLIC_FILES in server.js (minus the APK itself)
const FILES = [
  'index.html', 'style.css', 'app.js', 'manifest.json', 'sw.js',
  'netrontrade-logo.svg', 'favicon.png', 'app-icon.png', 'netrontrade-icon-192.png',
  'offline.html',
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of FILES) {
  const from = path.join(SRC, f);
  if (!fs.existsSync(from)) throw new Error(`Missing frontend file: ${f}`);
  fs.copyFileSync(from, path.join(OUT, f));
}
console.log(`web build: ${FILES.length} files -> ${path.relative(ROOT, OUT)}/`);
