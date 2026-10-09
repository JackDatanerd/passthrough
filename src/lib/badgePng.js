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

// Palette indices: 0 transparent (rounded corners), 1 label background, 2 value background, 3 text.
function renderBadgePng(label, value, valueColor = '#6b7280') {
  const lw = textWidth(label) + PAD * 2
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
  drawText(label, PAD)
  drawText(value, lw + PAD)

  // 2 bits per pixel, each row prefixed with filter type 0.
  const rowBytes = Math.ceil(width / 4)
  const raw = new Uint8Array(HEIGHT * (1 + rowBytes))
  for (let y = 0; y < HEIGHT; y++) {
    const base = y * (1 + rowBytes)
    for (let x = 0; x < width; x++) raw[base + 1 + (x >> 2)] |= px[y * width + x] << (6 - (x & 3) * 2)
  }

  const [r, g, b] = parseColor(valueColor)
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width); dv.setUint32(4, HEIGHT)
  ihdr[8] = 2; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0   // 2-bit, indexed colour
  const plte = Uint8Array.from([0, 0, 0, 0x37, 0x41, 0x51, r, g, b, 255, 255, 255])
  const trns = Uint8Array.from([0, 255, 255, 255])
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

module.exports = { renderBadgePng, textWidth, HEIGHT, SCALE }
