/**
 * Rasterises frontend/netrontrade-logo.svg into every PNG the app needs:
 *   - assets/            source images for @capacitor/assets (Android icon + splash)
 *   - frontend/          favicon / PWA / apple-touch PNGs
 *
 * Run: node scripts/generate-brand-assets.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'frontend', 'netrontrade-logo.svg'));
const BG = '#050505';

// The SVG carries its own rounded black tile; for full-bleed surfaces
// (launcher icon / splash) we want just the gold mark on a flat background.
const MARK_SVG = Buffer.from(
  SVG.toString()
    .replace(/<rect [^>]*\/>/, '')                        // drop rounded tile
    .replace(/<path d="M256 72[^>]*\/>/, '')              // drop faint diamond outline
);

async function mark(size) {
  return sharp(MARK_SVG, { density: 384 }).resize(size, size).png().toBuffer();
}

async function onBackground(canvas, markSize) {
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: BG } })
    .composite([{ input: await mark(markSize), gravity: 'center' }])
    .png().toBuffer();
}

async function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log('wrote', path.relative(ROOT, file));
}

(async () => {
  const assets = path.join(ROOT, 'assets');
  const fe = path.join(ROOT, 'frontend');

  // Android launcher icon sources (adaptive icon: 66% safe zone for the foreground)
  await write(path.join(assets, 'icon-only.png'), await onBackground(1024, 900));
  await write(path.join(assets, 'icon-foreground.png'),
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await mark(640), gravity: 'center' }]).png().toBuffer());
  await write(path.join(assets, 'icon-background.png'),
    await sharp({ create: { width: 1024, height: 1024, channels: 3, background: BG } }).png().toBuffer());

  // Splash (light + dark are identical: the brand is dark-only)
  const splash = await onBackground(2732, 720);
  await write(path.join(assets, 'splash.png'), splash);
  await write(path.join(assets, 'splash-dark.png'), splash);

  // Web / PWA PNGs (SVG-only icons are ignored by iOS and by Chrome's installability check)
  await write(path.join(fe, 'app-icon.png'), await onBackground(512, 400));
  await write(path.join(fe, 'netrontrade-icon-192.png'), await onBackground(192, 150));
  await write(path.join(fe, 'favicon.png'), await onBackground(64, 50));
})().catch(e => { console.error(e); process.exit(1); });
