// QR codes for a verification page's link (Verify round 9, feature gap).
//
// WHY: a verification link on a PRINTED resume (or a business card, a portfolio PDF) has to be typed
// by hand, character by character. GET /api/verify/:code/qr.svg|png hands the candidate a QR they can drop
// into Word / Canva / a print layout. The code never changes for a page, so the image is static and
// cacheable; it points at the live page, which says revoked / removed when that is the case.
//
// Encoding comes from `qrcode-generator` (pure JS, no wasm, no DOM). The PNG is 1-bit grayscale with stored
// deflate blocks, written with the same chunk helpers as the badge PNG — no extra dependency.

const qrcode = require('qrcode-generator')
const { chunk, zlibStored } = require('./badgePng')

const QUIET_MODULES = 4   // the quiet zone the QR spec asks for; scanners rely on it

function build(text) {
  // Type 0 = smallest version that fits; 'M' (15%) tolerates a smudge on paper without a bigger symbol.
  const qr = qrcode(0, 'M')
  qr.addData(String(text))
  qr.make()
  return { n: qr.getModuleCount(), dark: (r, c) => qr.isDark(r, c) }
}

function renderQrSvg(text, { scale = 8 } = {}) {
  const { n, dark } = build(text)
  const size = n + QUIET_MODULES * 2
  let d = ''
  for (let r = 0; r < n; r++) {
    let run = 0
    for (let c = 0; c <= n; c++) {
      if (c < n && dark(r, c)) { run++; continue }
      if (run) { d += `M${c - run + QUIET_MODULES} ${r + QUIET_MODULES}h${run}v1h-${run}z`; run = 0 }
    }
  }
  const px = size * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code for this verification page">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

function renderQrPng(text, { scale = 8 } = {}) {
  const { n, dark } = build(text)
  const size = (n + QUIET_MODULES * 2) * scale
  const rowBytes = Math.ceil(size / 8)
  const raw = new Uint8Array(size * (1 + rowBytes)).fill(0xff)   // 1 = white in 1-bit grayscale
  for (let y = 0; y < size; y++) {
    const base = y * (1 + rowBytes)
    raw[base] = 0   // filter: none
    const r = Math.floor(y / scale) - QUIET_MODULES
    if (r < 0 || r >= n) continue
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / scale) - QUIET_MODULES
      if (c >= 0 && c < n && dark(r, c)) raw[base + 1 + (x >> 3)] &= ~(0x80 >> (x & 7))
    }
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, size); dv.setUint32(4, size)
  ihdr[8] = 1; ihdr[9] = 0   // 1-bit, grayscale
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((len, p) => len + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

module.exports = { renderQrSvg, renderQrPng }
