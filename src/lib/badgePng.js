// PNG rendering of the embeddable status badge (Section 7, round 6).
//
// WHY THIS EXISTS: the badge was SVG-only, and the places a resume credential most wants to live do
// not take SVG: Gmail blocks SVG images, classic Outlook does not draw them, and LinkedIn / most ATS
// profile fields only accept raster images. A candidate could not put the badge in an e-mail
// signature at all.
//
// WHY NOT A RASTERIZER: a wasm rasterizer (resvg) plus a font file would add ~2 MB to a Worker bundle
// that has to stay under its size limit, and a wasm import does not bundle from this CommonJS source
// without build changes. The badge is two coloured rectangles and one line of text per half, so this
// draws it directly: a 5x7 pixel font on a 2-bit indexed canvas, encoded as a PNG with stored
// (uncompressed) deflate blocks. No dependencies, synchronous, deterministic, ~3-5 KB per image, and
// it runs identically in Node (tests) and in the Worker. The SVG stays the sharper, preferred format
// where it is supported; the PNG is the "works everywhere" one. Text is upper-case by necessity.

const SCALE = 2          // device pixels per CSS pixel — the PNG is meant to be shown at height 20
const GLYPH_W = 5, GLYPH_H = 7
const ADVANCE = (GLYPH_W + 1) * SCALE   // glyph + 1 column of spacing
const PAD = 7 * SCALE                   // horizontal padding inside each half
const HEIGHT = 20 * SCALE
const RADIUS = 3 * SCALE

// 5x7 glyphs, one 5-character string per row ('1' = ink).
const GLYPHS = {
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110', J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110', P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 10101 01010', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111', 3: '11110 00001 00001 01110 00001 00001 11110',
  4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110', 9: '01110 10001 10001 01111 00001 00010 01100',
  '/': '00001 00001 00010 00100 01000 10000 10000', '-': '00000 00000 00000 11111 00000 00000 00000',
  ' ': '00000 00000 00000 00000 00000 00000 00000', '?': '01110 10001 00001 00010 00100 00000 00100',
}
const GLYPH_ROWS = Object.fromEntries(Object.entries(GLYPHS).map(([k, v]) => [k, v.split(' ')]))

function textWidth(text) {
  const n = [...String(text)].length
  return n ? n * ADVANCE - SCALE : 0
}

function parseColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  const v = m ? parseInt(m[1], 16) : 0x6b7280
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

// CRC-32 (PNG chunk checksums).
let CRC_TABLE = null
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      CRC_TABLE[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function adler32(bytes) {
  let a = 1, b = 0
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521 }
  return ((b << 16) | a) >>> 0
}

// zlib stream made of STORED deflate blocks (no compression — the image is a few KB of mostly flat colour).
function zlibStored(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535))
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  let o = 0
  out[o++] = 0x78; out[o++] = 0x01
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535
    const len = Math.min(65535, raw.length - start)
    out[o++] = i === blocks - 1 ? 1 : 0
    out[o++] = len & 255; out[o++] = (len >> 8) & 255
    out[o++] = ~len & 255; out[o++] = (~len >> 8) & 255
    out.set(raw.subarray(start, start + len), o); o += len
  }
  const ad = adler32(raw)
  out[o++] = (ad >>> 24) & 255; out[o++] = (ad >>> 16) & 255; out[o++] = (ad >>> 8) & 255; out[o++] = ad & 255
  return out
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

// ── the Passthrough tile, rasterised (look 4's mark) ─────────────────────────────────────────────────────────────────────
// The same drawing as frontend/src/components/layout/VerifiedMark.jsx and the resume PDF's tile (32-unit grid), turned into palette
// indices because this file has no rasteriser. tileCoverage(size, { cut, verified, square }) -> Uint8Array(size*size) of:
//   0 outside the tile, 1 tile body, 2 filter bars, 3 check line.
// `square` leaves the corners to the caller (the badge strip rounds its own outer corners); otherwise the tile has its own 25% radius.
// Hard edges (a palette image has no alpha to anti-alias with): the shapes are tested at the pixel centre, which at 40 px or more reads cleanly.
const BARS_FULL = [[11, 6.5, 11, 12.5], [11, 19.5, 11, 25.5], [21, 6.5, 21, 12.5], [21, 19.5, 21, 25.5]]
const BARS_COMPACT = [[9.5, 6.5, 9.5, 10.5], [9.5, 21.5, 9.5, 25.5], [22.5, 6.5, 22.5, 10.5], [22.5, 21.5, 22.5, 25.5]]
const CHECK_FULL = [[4.5, 16, 11.9, 16], [11.9, 16, 15.8, 20.4], [15.8, 20.4, 26.2, 9.8]]
const CHECK_COMPACT = [[7.5, 16.4, 13.3, 22], [13.3, 22, 25, 10.6]]
const distToSegment = (px, py, [x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}
function tileCoverage(size, { cut = 'compact', verified = true, square = false } = {}) {
  const full = cut === 'full'
  const bars = full ? BARS_FULL : BARS_COMPACT, check = full ? CHECK_FULL : CHECK_COMPACT
  const barR = (full ? 2.6 : 3) / 2, checkR = (full ? 2.7 : 3.6) / 2
  const out = new Uint8Array(size * size)
  const k = 32 / size, rx = 8
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * k, v = (y + 0.5) * k
      if (!square) {   // rounded square, radius 8 of 32
        const cx = u < rx ? rx : u > 32 - rx ? 32 - rx : u, cy = v < rx ? rx : v > 32 - rx ? 32 - rx : v
        if ((u - cx) ** 2 + (v - cy) ** 2 > rx * rx) continue
      }
      let code = 1
      if (bars.some(b => distToSegment(u, v, b) <= barR)) code = 2
      if (verified && check.some(c => distToSegment(u, v, c) <= checkR)) code = 3
      out[y * size + x] = code
    }
  }
  return out
}

// Palette indices (4-bit): 0 transparent (rounded corners), 1 label background, 2 value background, 3 white (text, bars), 4 tile blue, 5 tile grey,
// 6 gold (the check), 7 light grey (the not-verified tile's bars).
function renderBadgePng(label, value, valueColor = '#6b7280') {
  // Look 4: the tile leads the strip (a check only when the badge says Verified - the same rule as the SVG: label 'Passthrough Verified').
  const tileW = HEIGHT   // a square the height of the strip
  const verified = label === 'Passthrough Verified'
  const lw = tileW + textWidth(label) + PAD * 2
  const vw = textWidth(value) + PAD * 2
  const width = lw + vw
  const px = new Uint8Array(width * HEIGHT)   // one palette index per pixel

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      // Rounded outer corners only (the seam between the halves stays square).
      const dx = x < RADIUS ? RADIUS - x - 0.5 : x >= width - RADIUS ? x - (width - RADIUS) + 0.5 : 0
      const dy = y < RADIUS ? RADIUS - y - 0.5 : y >= HEIGHT - RADIUS ? y - (HEIGHT - RADIUS) + 0.5 : 0
      if (dx > 0 && dy > 0 && dx * dx + dy * dy > RADIUS * RADIUS) continue
      px[y * width + x] = x < lw ? 1 : 2
    }
  }

  const top = Math.floor((HEIGHT - GLYPH_H * SCALE) / 2)
  function drawText(text, left) {
    let cx = left
    for (const ch of String(text).toUpperCase()) {
      const rows = GLYPH_ROWS[ch] || GLYPH_ROWS['?']
      for (let r = 0; r < GLYPH_H; r++) {
        for (let c = 0; c < GLYPH_W; c++) {
          if (rows[r][c] !== '1') continue
          for (let dy = 0; dy < SCALE; dy++)
            for (let dx = 0; dx < SCALE; dx++) px[(top + r * SCALE + dy) * width + cx + c * SCALE + dx] = 3
        }
      }
      cx += ADVANCE
    }
  }
  drawText(label, tileW + PAD)
  drawText(value, lw + PAD)

  // The tile, over the left square. Outer corners were already cut above; a 1 px white seam (half a CSS pixel) separates it from the label.
  const cover = tileCoverage(tileW, { cut: 'compact', verified, square: true })
  const bodyIdx = verified ? 4 : 5, barIdx = verified ? 3 : 7
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < tileW; x++) {
      if (px[y * width + x] === 0) continue          // the rounded outer corner stays transparent
      const code = cover[y * tileW + x]
      px[y * width + x] = x === tileW - 1 ? 3 : code === 3 ? 6 : code === 2 ? barIdx : bodyIdx
    }
  }

  // 4 bits per pixel, each row prefixed with filter type 0.
  const rowBytes = Math.ceil(width / 2)
  const raw = new Uint8Array(HEIGHT * (1 + rowBytes))
  for (let y = 0; y < HEIGHT; y++) {
    const base = y * (1 + rowBytes)
    for (let x = 0; x < width; x++) raw[base + 1 + (x >> 1)] |= px[y * width + x] << ((x & 1) ? 0 : 4)
  }

  const [r, g, b] = parseColor(valueColor)
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width); dv.setUint32(4, HEIGHT)
  ihdr[8] = 4; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0   // 4-bit, indexed colour
  const plte = Uint8Array.from([0, 0, 0, 0x37, 0x41, 0x51, r, g, b, 255, 255, 255, 0x1e, 0x40, 0xaf, 0x6b, 0x72, 0x80, 0xff, 0xe2, 0x7a, 0xd1, 0xd5, 0xdb])
  const trns = Uint8Array.from([0])
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// ROUND-7 (feature gap, Section 7): a link-preview card. The page's og:image was the site-wide
// logo, so a verification link pasted into LinkedIn / Slack / WhatsApp / iMessage looked like every
// other Passthrough link and the one thing the reader wants to know — is this resume verified, and
// at what score — was not on the picture. 1200x630 is the size those previews use; drawn with the
// same 5x7 font and stored-deflate encoder as the badge (no rasterizer, no dependencies).
// Palette: 0 white, 1 dark text, 2 status colour, 3 muted text. No '.' or ':' glyph exists — callers
// pass text made of the glyph set only (unknown characters draw as '?').
const CARD_W = 1200, CARD_H = 630, CARD_MARGIN = 80

function fitScale(text, maxScale, maxWidth) {
  const n = [...String(text)].length
  if (!n) return maxScale
  return Math.max(1, Math.min(maxScale, Math.floor(maxWidth / (n * (GLYPH_W + 1) - 1))))
}

function renderSharePng({ headline = '', big = '', sub = '', footer = '', color = '#6b7280', mark = null } = {}) {   // mark: 'verified' | 'neutral' | null
  const px = new Uint8Array(CARD_W * CARD_H)   // palette index 0 = white
  const fill = (x0, y0, w, h, idx) => { for (let y = y0; y < y0 + h; y++) px.fill(idx, y * CARD_W + x0, y * CARD_W + x0 + w) }
  function draw(text, x, y, scale, idx) {
    let cx = x
    for (const ch of String(text).toUpperCase()) {
      const rows = GLYPH_ROWS[ch] || GLYPH_ROWS['?']
      for (let r = 0; r < GLYPH_H; r++)
        for (let c = 0; c < GLYPH_W; c++)
          if (rows[r][c] === '1') fill(cx + c * scale, y + r * scale, scale, scale, idx)
      cx += (GLYPH_W + 1) * scale
    }
  }
  const inner = CARD_W - CARD_MARGIN * 2
  fill(0, 0, CARD_W, 28, 2)                    // status colour bar
  fill(0, CARD_H - 28, CARD_W, 28, 2)
  // Look 4: the tile leads the headline (full cut, with a check only for 'verified'; grey and empty for anything else).
  const TILE = 150, tileGap = 40
  const headX = mark ? CARD_MARGIN + TILE + tileGap : CARD_MARGIN
  if (mark) {
    const cover = tileCoverage(TILE, { cut: 'full', verified: mark === 'verified' })
    const body = mark === 'verified' ? 4 : 6, bars = mark === 'verified' ? 0 : 7
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const code = cover[y * TILE + x]
        if (code) px[(92 + y) * CARD_W + CARD_MARGIN + x] = code === 3 ? 5 : code === 2 ? bars : body
      }
  }
  const hs = fitScale(headline, 9, CARD_W - CARD_MARGIN - headX)
  draw(headline, headX, mark ? 92 + Math.round((TILE - GLYPH_H * hs) / 2) : 120, hs, 2)
  if (big) { const bs = fitScale(big, mark ? 20 : 26, inner); draw(big, CARD_MARGIN, mark ? 92 + TILE + 28 : 120 + GLYPH_H * hs + 56, bs, 1) }
  if (sub) draw(sub, CARD_MARGIN, 440, fitScale(sub, 6, inner), 3)
  if (footer) draw(footer, CARD_MARGIN, 520, fitScale(footer, 6, inner), 3)

  const rowBytes = Math.ceil(CARD_W / 2)
  const raw = new Uint8Array(CARD_H * (1 + rowBytes))
  for (let y = 0; y < CARD_H; y++) {
    const base = y * (1 + rowBytes)
    for (let x = 0; x < CARD_W; x++) raw[base + 1 + (x >> 1)] |= px[y * CARD_W + x] << ((x & 1) ? 0 : 4)
  }
  const [r, g, b] = parseColor(color)
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, CARD_W); dv.setUint32(4, CARD_H)
  ihdr[8] = 4; ihdr[9] = 3   // 4-bit indexed
  // 0 white, 1 dark text, 2 status colour, 3 muted text, 4 tile blue, 5 gold, 6 tile grey, 7 light grey (the not-verified tile's bars)
  const plte = Uint8Array.from([255, 255, 255, 0x11, 0x18, 0x27, r, g, b, 0x6b, 0x72, 0x80, 0x1e, 0x40, 0xaf, 0xff, 0xe2, 0x7a, 0x6b, 0x72, 0x80, 0xd1, 0xd5, 0xdb])
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

module.exports = { renderBadgePng, renderSharePng, tileCoverage, textWidth, HEIGHT, SCALE, CARD_W, CARD_H, chunk, zlibStored }
