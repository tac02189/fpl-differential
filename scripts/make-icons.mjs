// Regenerates every app icon + the link-preview image from public/logo.png.
//   node scripts/make-icons.mjs
// Run after replacing public/logo.png with a new logo (square PNG, ideally >=1024px).
import { existsSync } from 'node:fs'
import sharp from 'sharp'

const SRC = 'public/logo.png'
if (!existsSync(SRC)) {
  console.error(`Missing ${SRC} — drop the logo there first.`)
  process.exit(1)
}

// Match the logo's own background (it isn't pure white) so padded canvases
// blend seamlessly instead of showing a faint seam around the artwork.
const corner = await sharp(SRC).extract({ left: 0, top: 0, width: 8, height: 8 }).raw().toBuffer()
const WHITE = { r: corner[0], g: corner[1], b: corner[2], alpha: 1 }
const flat = () => sharp(SRC).flatten({ background: WHITE })

// Below ~96px the "FPL DIFFERENTIAL" wordmark turns to mush, so tiny icons use
// an emblem-only crop (ball + chart line) that stays readable in a browser tab.
// Coordinates are tuned to this 1254px artwork — recheck them if the logo changes.
const EMBLEM = { left: 300, top: 145, width: 655, height: 655 }
const emblem = () => sharp(SRC).extract(EMBLEM).flatten({ background: WHITE })

// Plain icons: logo fills the tile (host OS applies its own rounding).
const SQUARE = [
  ['public/pwa-192x192.png', 192],
  ['public/pwa-512x512.png', 512],
  ['public/apple-touch-icon-180x180.png', 180],
]

// Maskable: Android crops to a circle/squircle, so the art must sit inside the
// inner ~80% safe zone with white filling the rest.
async function maskable() {
  const size = 512
  const inner = Math.round(size * 0.78)
  const art = await flat().resize(inner, inner, { fit: 'contain', background: WHITE }).toBuffer()
  const pad = Math.round((size - inner) / 2)
  await sharp({ create: { width: size, height: size, channels: 3, background: WHITE } })
    .composite([{ input: art, top: pad, left: pad }])
    .png()
    .toFile('public/maskable-icon-512x512.png')
}

// Link preview (Open Graph / iMessage / WhatsApp): 1200x630 landscape, logo centered.
async function og() {
  const [w, h] = [1200, 630]
  const art = await flat().resize(560, 560, { fit: 'contain', background: WHITE }).toBuffer()
  await sharp({ create: { width: w, height: h, channels: 3, background: WHITE } })
    .composite([{ input: art, top: Math.round((h - 560) / 2), left: Math.round((w - 560) / 2) }])
    .png()
    .toFile('public/og.png')
}

const meta = await sharp(SRC).metadata()
console.log(`source ${SRC}: ${meta.width}x${meta.height} ${meta.format}`)
if (meta.width < 512) console.warn('warning: source is under 512px — icons will look soft.')

await Promise.all([
  ...SQUARE.map(([out, size]) =>
    flat().resize(size, size, { fit: 'contain', background: WHITE }).png().toFile(out),
  ),
  emblem().resize(64, 64).png().toFile('public/pwa-64x64.png'),
  maskable(),
  og(),
])

// favicon.ico (16/32/48) — sharp writes PNG only, so pack the sizes with sharp-ico.
try {
  const ico = (await import('sharp-ico')).default
  const frames = await Promise.all([16, 32, 48].map(s => emblem().resize(s, s).png().toBuffer()))
  ico.sharpsToIco(frames.map(b => sharp(b)), 'public/favicon.ico')
} catch {
  console.warn('skipped favicon.ico (sharp-ico unavailable) — PNG icons still cover modern browsers.')
}

console.log('Wrote pwa-64/192/512, apple-touch-icon-180, maskable-512, favicon.ico, og.png')
