// PDF ingest: one pass over an uploaded PDF that returns its text AND the facts the text can't show.
//
// SCAN/ATS ROUND 4 — what this closes (all of it was invisible before; a PDF was only ever `extractText`'d):
//   * Hyperlinks. "LinkedIn" / "Portfolio" text that is a link lives in an annotation, not in the text, so the
//     URL never reached the structurer and the regenerated resume silently lost it. Link targets are returned.
//   * Layout. A PDF has no <w:tbl>/<w:cols> to read, so columns / images went unpenalised (inspectStructure
//     returned null for every PDF — and most uploads are PDFs). Columns are read from text-item positions,
//     images from the operator list.
//   * Hidden text. Tiny (<= 3.5pt), off-page and white-on-white text used to count towards the keyword score.
//     Tiny and off-page runs are now dropped from the text; white text is counted (it cannot be mapped back to
//     individual items) and reported so the scorer can penalise it.
//   * A page cap. Only the COMPRESSED size was bounded (5MB), so a many-page PDF could burn the queue
//     consumer's CPU. Anything over MAX_PDF_PAGES is refused with its own failure code.
//   * Failure codes. ENCRYPTED_PDF / TOO_MANY_PAGES / UNREADABLE_FILE are told apart instead of all being "".
//
// Never throws: a PDF it cannot read comes back as `{ failure: { code } }`.

const MAX_PDF_PAGES = 12
// Pages inspected for layout / colour / images. A resume's layout is the same on page 3 as on page 1.
const LAYOUT_PAGES = 3
const TINY_FONT_PT = 3.5
const MAX_LINKS = 12

function allowedLink(url) {
  return typeof url === 'string' && /^(https?:|mailto:|tel:)/i.test(url.trim()) && url.length <= 300
}

// Luminance of a 0-255 colour, 0..1.
function luminance(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 }

function rgbOf(args) {
  if (!args) return null
  const r = Number(args[0]), g = Number(args[1]), b = Number(args[2])
  if ([r, g, b].some(n => !Number.isFinite(n))) return null
  return [r, g, b]
}

// Walks one page's operator list. Returns white-text characters, whether the page has a large dark fill (a
// dark header band legitimately carries white text, so the white-text rule stands down there) and the number
// of substantial images.
function scanOperators(opList, OPS, pageArea) {
  const out = { whiteChars: 0, darkFill: false, images: 0 }
  let color = [0, 0, 0]
  const stack = []
  let lastBox = null
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].filter(v => v !== undefined))
  const { fnArray, argsArray } = opList
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]
    const args = argsArray[i]
    if (op === OPS.save) stack.push(color)
    else if (op === OPS.restore) color = stack.pop() || color
    else if (op === OPS.setFillRGBColor) color = rgbOf(args) || color
    else if (op === OPS.setFillGray) { const g = Number(args?.[0]); if (Number.isFinite(g)) color = [g, g, g] }
    else if (op === OPS.constructPath) lastBox = Array.isArray(args?.[2]) ? args[2] : null
    else if (fillOps.has(op)) {
      if (lastBox && luminance(...color) < 0.8) {
        const area = Math.abs((lastBox[2] - lastBox[0]) * (lastBox[3] - lastBox[1]))
        if (pageArea > 0 && area / pageArea > 0.01) out.darkFill = true
      }
    } else if (op === OPS.showText) {
      if (luminance(...color) >= 0.94) {
        const glyphs = Array.isArray(args?.[0]) ? args[0] : []
        for (const gl of glyphs) if (gl && typeof gl === 'object' && gl.unicode && /\S/.test(gl.unicode)) out.whiteChars++
      }
    } else if (op === OPS.paintImageXObject) {
      const w = Number(args?.[1]), h = Number(args?.[2])
      if (w >= 60 && h >= 60) out.images++
    } else if (op === OPS.paintInlineImageXObject) {
      const d = args?.[0]
      if (d && d.width >= 60 && d.height >= 60) out.images++
    }
  }
  return out
}

// Two-column detection from where text starts. A right-aligned date or location is short; a column is long
// text sitting beside long text on the same baseline, over and over.
function detectColumns(pagesItems, pageWidth) {
  let bands = 0
  for (const items of pagesItems) {
    const byY = new Map()
    for (const it of items) {
      const key = Math.round(it.y / 3)
      if (!byY.has(key)) byY.set(key, [])
      byY.get(key).push(it)
    }
    for (const row of byY.values()) {
      if (row.length < 2) continue
      row.sort((a, b) => a.x - b.x)
      const left = row.find(it => it.x < pageWidth * 0.42 && it.len >= 14)
      if (!left) continue
      const right = row.find(it => it.x > pageWidth * 0.38 && it.x > left.x + left.w + 20 && it.len >= 22)
      if (right) bands++
    }
  }
  return bands >= 5 ? 2 : 1
}

async function analyzePdf(bytes) {
  let unpdf
  try { unpdf = await import('unpdf') } catch (err) { return { failure: { code: 'UNREADABLE_FILE' }, error: err.message } }
  let pdf
  try {
    // A copy: pdf.js may take ownership of the buffer it is handed.
    pdf = await unpdf.getDocumentProxy(new Uint8Array(bytes))
  } catch (err) {
    const code = err && err.name === 'PasswordException' ? 'ENCRYPTED_PDF' : 'UNREADABLE_FILE'
    return { failure: { code }, error: err?.message }
  }
  try {
    const pages = pdf.numPages
    if (pages > MAX_PDF_PAGES) return { failure: { code: 'TOO_MANY_PAGES', pages } }

    let OPS = null
    try { OPS = (await unpdf.getResolvedPDFJS()).OPS } catch (_) { /* layout checks degrade, text still works */ }

    const pageTexts = []
    const layoutItems = []
    const links = []
    let hiddenChars = 0
    let whiteChars = 0
    let images = 0
    let darkFill = false
    let pageWidth = 595

    for (let p = 1; p <= pages; p++) {
      const page = await pdf.getPage(p)
      const view = page.view || [0, 0, 595, 842]
      if (p === 1) pageWidth = view[2] - view[0]
      const content = await page.getTextContent()
      let text = ''
      const items = []
      for (const it of content.items) {
        if (typeof it.str !== 'string') continue
        const visible = /\S/.test(it.str)
        const t = it.transform || [1, 0, 0, 1, 0, 0]
        const tiny = visible && it.height > 0 && it.height <= TINY_FONT_PT
        const off = visible && (t[4] < view[0] - 2 || t[4] > view[2] + 2 || t[5] < view[1] - 2 || t[5] > view[3] + 2)
        if (tiny || off) { hiddenChars += it.str.replace(/\s/g, '').length; continue }
        // pdf.js follows a line with an empty end-of-line marker item; one newline per line, never a blank line per marker.
        text += it.str
        if (it.hasEOL && !text.endsWith('\n')) text += '\n'
        if (visible && p <= LAYOUT_PAGES) items.push({ x: t[4], y: t[5], w: it.width || 0, len: it.str.trim().length })
      }
      pageTexts.push(text)
      if (p <= LAYOUT_PAGES) layoutItems.push(items)

      try {
        for (const a of await page.getAnnotations()) {
          if (a && a.subtype === 'Link' && allowedLink(a.url) && !links.includes(a.url.trim()) && links.length < MAX_LINKS) links.push(a.url.trim())
        }
      } catch (_) { /* annotations are a bonus */ }

      if (OPS && p <= LAYOUT_PAGES) {
        try {
          const o = scanOperators(await page.getOperatorList(), OPS, (view[2] - view[0]) * (view[3] - view[1]))
          whiteChars += o.whiteChars; images += o.images; darkFill = darkFill || o.darkFill
        } catch (_) { /* colour/image checks are a bonus */ }
      }
    }

    const text = pageTexts.join('\n\n')
    const hidden = hiddenChars + (darkFill ? 0 : whiteChars)
    return {
      failure: null,
      text,
      links,
      structure: {
        pages,
        columns: detectColumns(layoutItems, pageWidth),
        images,
        hiddenTextChars: hidden,
      },
    }
  } catch (err) {
    return { failure: { code: 'UNREADABLE_FILE' }, error: err?.message }
  } finally {
    try { await pdf.destroy?.() } catch (_) { /* nothing to free */ }
  }
}

module.exports = { analyzePdf, MAX_PDF_PAGES, scanOperators, detectColumns }
