// A minimal PDF writer for tests: real, parseable PDFs with positioned text (any colour/size), filled rectangles, link
// annotations and images — so ingest behaviour is tested against actual PDF bytes, with no binary fixtures committed.
// Not a general PDF library: Helvetica only, one content stream per page, no compression.
const enc = s => new TextEncoder().encode(s)
// \225 is the bullet in WinAnsi, the encoding Helvetica uses; a UTF-8 bullet would render as three garbage characters.
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\u2022/g, '\\225')

// pages: [{ ops: [ {text,x,y,size?,color?} | {rect:[x,y,w,h],color?} | {link:{rect:[x1,y1,x2,y2],url}} | {image:{x,y,w,h,px?}} ] }]
function buildPdf(pages, { width = 595, height = 842 } = {}) {
  const objs = []                       // index = object number - 1
  const add = body => { objs.push(body); return objs.length }
  const catalog = add(null), pagesObj = add(null), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids = []
  for (const page of pages) {
    let content = '', annots = [], xobjs = []
    for (const op of page.ops) {
      const col = (op.color || [0, 0, 0]).map(v => (v / 255).toFixed(3)).join(' ')
      if (op.text !== undefined) content += `BT ${col} rg /F1 ${op.size || 10} Tf ${op.x} ${op.y} Td (${esc(op.text)}) Tj ET\n`
      else if (op.rect) content += `${col} rg ${op.rect.join(' ')} re f\n`
      else if (op.image) {
        const n = op.image.px || 64, raw = new Uint8Array(n * n * 3).fill(200)
        const img = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${n} /Height ${n} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${raw.length} >>`, stream: raw })
        xobjs.push(img)
        content += `q ${op.image.w} 0 0 ${op.image.h} ${op.image.x} ${op.image.y} cm /Im${img} Do Q\n`
      } else if (op.link) {
        annots.push(add(`<< /Type /Annot /Subtype /Link /Rect [${op.link.rect.join(' ')}] /Border [0 0 0] /A << /S /URI /URI (${esc(op.link.url)}) >> >>`))
      }
    }
    const stream = enc(content)
    const cs = add({ dict: `<< /Length ${stream.length} >>`, stream })
    const xo = xobjs.length ? `/XObject << ${xobjs.map(i => `/Im${i} ${i} 0 R`).join(' ')} >>` : ''
    const pg = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${cs} 0 R /Resources << /Font << /F1 ${font} 0 R >> ${xo} >>${annots.length ? ` /Annots [${annots.map(a => `${a} 0 R`).join(' ')}]` : ''} >>`)
    kids.push(pg)
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`

  const chunks = [enc('%PDF-1.4\n')]
  let offset = chunks[0].length
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(offset)
    const parts = typeof o === 'string'
      ? [enc(`${i + 1} 0 obj\n${o}\nendobj\n`)]
      : [enc(`${i + 1} 0 obj\n${o.dict}\nstream\n`), o.stream, enc('\nendstream\nendobj\n')]
    for (const p of parts) { chunks.push(p); offset += p.length }
  })
  const xref = offset
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  tail += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  chunks.push(enc(tail))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

const BODY = [
  'Built REST services for internal finance tools used across three regions of the company',
  'Improved reporting performance by 40% by rewriting slow queries for the data team',
  'Led a team of 3 engineers delivering a billing migration ahead of schedule',
  'Maintained deployment scripts and monitored production services for the platform team',
]
// A normal one-column resume page. `extra` ops are appended (hidden text, links, bands…).
function resumePage(extra = []) {
  const ops = []
  let y = 780
  const line = (text, o = {}) => { ops.push({ text, x: 50, y, size: o.size || 10, color: o.color }); y -= o.gap || 14 }
  line('Jane Doe', { size: 18, gap: 22 })
  line('jane@example.com | Nairobi | LinkedIn', { gap: 28 })
  for (const [head, lines] of [
    ['SUMMARY', ['Backend developer with experience building web services.']],
    ['EXPERIENCE', ['Developer - Foo Ltd - 2019 - 2024', ...BODY.map(b => '• ' + b)]],
    ['EDUCATION', ['BSc Computer Science - University of Nairobi - 2015 - 2019']],
    ['SKILLS', ['JavaScript, SQL, Git, Linux, REST APIs']],
  ]) { line(head, { size: 12, gap: 16 }); for (const l of lines) line(l); y -= 8 }
  return { ops: [...ops, ...extra] }
}

module.exports = { buildPdf, resumePage, BODY }
