// A tiny, dependency-free, text-only PDF writer — just enough to produce the one-page "proof of delivery" file that is
// uploaded to Paystack when a dispute is contested (Webhooks round 15, G1). Browser Rendering is deliberately not used:
// this runs inside an admin request and must not depend on a headless browser session. ASCII only (anything else is
// replaced), Helvetica, no images.

const PAGE_W = 612, PAGE_H = 792, MARGIN = 54, LEADING = 15, TITLE_SIZE = 16, BODY_SIZE = 10.5
const MAX_CHARS = 92

function ascii(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]/g, '?')
}
function esc(s) { return ascii(s).replace(/([\\()])/g, '\\$1') }

function wrap(line) {
  const words = ascii(line).split(' ')
  const out = []
  let cur = ''
  for (let w of words) {
    while (w.length > MAX_CHARS) {            // a long token (URL, id) is split rather than run off the page
      if (cur) { out.push(cur); cur = '' }
      out.push(w.slice(0, MAX_CHARS)); w = w.slice(MAX_CHARS)
    }
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= MAX_CHARS) cur += ' ' + w
    else { out.push(cur); cur = w }
  }
  out.push(cur)
  return out
}

/** buildProofPdf({ title, lines }) -> Uint8Array. `lines` is an array of strings ('' = blank line). */
function buildProofPdf({ title, lines }) {
  const body = []
  for (const l of lines || []) body.push(...(l === '' ? [''] : wrap(l)))
  const perPage = Math.floor((PAGE_H - 2 * MARGIN - 40) / LEADING)
  const pages = []
  for (let i = 0; i < body.length; i += perPage) pages.push(body.slice(i, i + perPage))
  if (!pages.length) pages.push([])

  const objs = []                                   // index = object number - 1
  const add = s => { objs.push(s); return objs.length }
  const catalog = add('')                           // 1, filled below
  const pagesObj = add('')                          // 2
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')   // 3
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>') // 4
  const kids = []
  pages.forEach((pg, idx) => {
    let y = PAGE_H - MARGIN
    let s = 'BT\n'
    if (idx === 0) { s += `/F2 ${TITLE_SIZE} Tf\n1 0 0 1 ${MARGIN} ${y} Tm\n(${esc(title)}) Tj\n`; y -= 34 }
    else y -= 4
    s += `/F1 ${BODY_SIZE} Tf\n`
    for (const l of pg) { s += `1 0 0 1 ${MARGIN} ${y} Tm\n(${esc(l)}) Tj\n`; y -= LEADING }
    s += 'ET'
    const content = add(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`)
    const page = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`)
    kids.push(`${page} 0 R`)
  })
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`

  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)             // everything above is ASCII, so string offsets are byte offsets
}

module.exports = { buildProofPdf }
