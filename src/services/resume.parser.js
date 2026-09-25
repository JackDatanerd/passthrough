// pdf-parse uses String.fromCharCode.apply(null, largeTypedArray) internally,
// which overflows the Cloudflare Workers call stack for any non-trivial PDF.
// Replaced with `unpdf`, which uses pdfjs-dist's edge-compatible build and
// is specifically designed for Worker/edge runtimes.
//
// .docx extraction uses jszip + native Promises directly (see extractDocxText
// below) rather than mammoth — see that function's comment for why.
//
// unpdf is ESM-only, so it's loaded via dynamic import() — esbuild (wrangler's
// bundler) handles the CJS/ESM mix at bundle time without any issues.

const JSZip   = require('jszip')
const c        = require('../config/constants')

// ZIP-BOMB DEFENCE. The 5MB upload cap (middleware/upload.js) only bounds the
// COMPRESSED size on the wire; DEFLATE can expand ~1000:1, so a 5MB .docx can
// inflate to gigabytes and exhaust the Worker's 128MB before any check on the
// finished string could run. (The previous guard — `xml.length > MAX` after
// `entry.async('string')` — fired only AFTER that full inflation, so it could
// not stop a bomb, only reject a large-but-survivable one.)
//
// The entry is therefore inflated as a STREAM and the read is abandoned the
// moment the running byte count crosses the cap, so memory stays bounded by
// the cap plus at most one inflate step regardless of what the archive claims
// about itself (the sizes in a zip header are attacker-controlled and cannot
// be trusted). A legitimate resume's document.xml is reliably well under 1MB;
// 20MB is generous headroom for an unusually long real resume.
const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024

function readEntryCapped(entry, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    const helper = entry.internalStream('uint8array')
    helper
      .on('data', chunk => {
        if (settled) return
        total += chunk.length
        if (total > maxBytes) {
          settled = true
          helper.pause()   // stop the inflate pipeline; nothing more is buffered
          reject(new Error('Document content too large after decompression — not a valid resume file'))
          return
        }
        chunks.push(chunk)
      })
      .on('error', err => { if (!settled) { settled = true; reject(err) } })
      .on('end', () => {
        if (settled) return
        settled = true
        const out = new Uint8Array(total)
        let off = 0
        for (const ch of chunks) { out.set(ch, off); off += ch.length }
        resolve(out)
      })
    helper.resume()
  })
}

// Direct .docx text extraction via JSZip + native Promises, bypassing
// mammoth's extractRawText entirely for this specific call.
//
// Context: mammoth's extractRawText was consistently throwing "Could not
// find file in options" in production — but a live diagnostic log
// (console.log of typeof/constructor/length right before the call)
// confirmed the input was a genuine, correctly-shaped, non-empty
// Uint8Array every single time. A local Node reproduction with the same
// mammoth version confirmed that error can ONLY happen when mammoth's
// `buffer` option is truly undefined — never for a valid Uint8Array. Since
// the input was proven valid but the failure was 100% reproducible in
// production and 0% reproducible locally, the remaining difference is the
// execution environment itself: mammoth uses `bluebird` (a full third-party
// Promise library with its own internal object pooling for performance)
// instead of native Promises for all of its internal async plumbing, and
// bluebird was never built with Cloudflare Workers' isolate-reuse-across-
// requests execution model in mind — unlike a fresh Node process per
// request, a Workers isolate can retain module-level state across many
// requests, which is exactly the kind of thing a pooling-optimized promise
// library can behave unpredictably under.
//
// Rather than keep debugging a third-party library's internal scheduling
// inside an environment it wasn't designed for, this extracts only what's
// actually needed (plain text from the document body) directly via jszip
// (which mammoth itself depends on, so this doesn't add a new dependency)
// and native Promises throughout. This intentionally doesn't replicate
// every OOXML edge case mammoth's full HTML conversion handles (tables,
// headers/footers, text boxes) — it targets standard resume body text,
// which is what actually needs to reach the ATS scorer and Claude.
// Turns one WordprocessingML part (document/header/footer XML) into text lines.
function docxXmlToLines(xml) {
  // AUDIT FIX (Auth/Scan round): text boxes are stored TWICE — a DrawingML
  // copy (mc:Choice) and a VML copy (mc:Fallback) — and both contain <w:p>
  // text, so every text-box resume duplicated its content. Keep one copy.
  xml = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '')
  // `<w:p ... />` (an empty, self-closed paragraph) must not open a match that
  // swallows the NEXT paragraph's closing tag.
  const paragraphs = xml.match(/<w:p\b[^>]*?(?<!\/)>[\s\S]*?<\/w:p>/g) || []
  return paragraphs.map(p => {
    // Convert tabs/line-breaks within a paragraph before stripping tags, so
    // cell/line structure isn't just silently collapsed into one run. These
    // get matched alongside <w:t> content below (not separately extracted
    // afterward) since a separate extraction pass would only look inside
    // <w:t>...</w:t> tags and silently drop any inserted \t/\n sitting
    // outside them.
    const withBreaks = p.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
    const parts = []
    for (const m of withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|[\t\n]/g)) {
      parts.push(m[1] !== undefined ? m[1] : m[0])
    }
    // AUDIT FIX (Auth/Scan round): entity decoding ran &amp; FIRST, so the
    // literal text "&lt;" (stored as "&amp;lt;") came out as "<"; numeric
    // references (&#8211; &#x2013;) were never decoded at all. &amp; is last.
    const text = parts.join('')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 10), 0x10ffff)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
    // AUDIT FIX (Auth/Scan round) — the single biggest scoring defect found:
    // a Word bullet or numbered item is NOT text. The marker lives in
    // numbering.xml and the paragraph only carries <w:numPr> (or a List*
    // style), so a resume with ordinary Word bullets extracted as bare lines
    // with no bullet character at all. The content scorer found zero bullets,
    // Content collapsed to 0, and the same resume scored 73 instead of 89
    // (measured; this app's own generated DOCX emits a literal "•" for
    // exactly this reason). List paragraphs now get a "• " marker.
    const isListItem =
      (/<w:numPr>[\s\S]*?<\/w:numPr>/.test(p) && !/<w:numId\b[^>]*w:val="0"/.test(p)) ||
      /<w:pStyle\b[^>]*w:val="List(?:Bullet|Number|Continue)\d?"/i.test(p)
    return isListItem && text.trim() ? `• ${text}` : text
  })
}

// Contact details in a Word HEADER (name / phone / email / links — a very
// common template design) live in word/header*.xml, not document.xml.
// AUDIT FIX (Auth/Scan round): they were never read, so such a resume was
// flagged "Contact missing" (-21 points) and the parse could not find the
// email or phone. Headers are read in full; footers only for lines that carry
// contact information, so page-number boilerplate doesn't add noise.
const CONTACT_LINE = /@|linkedin\.|github\.|\+?\d[\d\s().-]{7,}/i

async function extractDocxText(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const docXml = zip.file('word/document.xml')
  if (!docXml) throw new Error('word/document.xml not found — not a valid .docx file')
  // Capped streaming inflate — see the ZIP-BOMB DEFENCE comment above.
  const xml = new TextDecoder('utf-8').decode(await readEntryCapped(docXml, MAX_DOCX_XML_BYTES))
  const body = docxXmlToLines(xml).filter(Boolean)

  const readParts = async re => {
    const out = []
    for (const entry of (zip.file(re) || []).slice(0, 6)) {
      try { out.push(...docxXmlToLines(new TextDecoder('utf-8').decode(await readEntryCapped(entry, MAX_DOCX_XML_BYTES))).filter(Boolean)) }
      catch (_) { /* a broken header part must never fail the whole extraction */ }
    }
    return out
  }
  const seen = new Set(body)
  const header = (await readParts(/^word\/header\d*\.xml$/)).filter(l => !seen.has(l) && seen.add(l))
  const footer = (await readParts(/^word\/footer\d*\.xml$/)).filter(l => CONTACT_LINE.test(l) && !seen.has(l) && seen.add(l))
  return [...header, ...body, ...footer].join('\n')
}

async function extractText(bytes, mimeType) {
  try {
    if (mimeType === 'application/pdf') {
      const { extractText: pdfExtract } = await import('unpdf')
      // mergePages: true is required — without it, unpdf returns `text` as an
      // array of per-page strings (string[]) instead of one merged string,
      // which crashes every caller that does rawResumeText.trim() downstream.
      const { text } = await pdfExtract(bytes, { mergePages: true })
      return text || ''
    }
    return await extractDocxText(bytes)
  } catch (err) {
    console.error('extractText:', err.message)
    return ''
  }
}

// Used by generateFix/generateBadge only — calls Claude
async function parse(env, bytes, mimeType) {
  const text = await extractText(bytes, mimeType)
  if (!text || text.trim().length < 100)
    return {
      text: '',
      resumeData: null,
      parseError: true,
      parseErrorMessage: 'Resume could not be parsed. Upload a text-based PDF or .docx.'
    }
  // AUDIT FIX (Auth/Scan round): was c.MAX_RESUME_CHARS (8000 — sized for the
  // brain-dump box). A 3-page resume is 8-10k characters, so everything past
  // char 8000 (Education, Skills, older roles) was silently cut BEFORE the
  // structuring step — and the paid rewrite is built from that structure, so
  // the delivered resume permanently lacked it. Uploaded files get their own,
  // larger cap.
  const truncated = text.slice(0, c.MAX_RESUME_TEXT_CHARS)
  const claude    = require('./claude.service')
  const result    = await claude.parseResumeStructure(env, truncated)
  if (!result.success)
    return {
      text: truncated,
      resumeData: null,
      parseError: true,
      // Preserve the real reason (RESPONSE_TRUNCATED / PARSE_FAIL / an
      // Anthropic API error message) instead of masking it with a generic
      // string — this is what showed up as "Could not extract resume
      // structure" with no further detail in production logs.
      parseErrorMessage: `Could not extract resume structure (${result.error || 'unknown'}).`
    }
  return { text: truncated, resumeData: result.data, parseError: false }
}

// Brain-dump entry path (Phase 1) equivalent of parse() above. There's no
// file to extract text from — the raw text IS the input — so this skips
// straight to structuring via claude.service's structureFreeformText.
// Same return shape as parse() so runAtsScan/generateFix/generateBadge can
// treat both entry paths identically after this point.
async function structureBrainDump(env, rawText) {
  if (!rawText || rawText.trim().length < 100)
    return {
      text: '',
      resumeData: null,
      parseError: true,
      parseErrorMessage: 'Tell us a bit more about your background — at least a few sentences.'
    }
  const truncated = rawText.slice(0, c.MAX_RESUME_CHARS)
  const claude = require('./claude.service')
  const result = await claude.structureFreeformText(env, truncated)
  if (!result.success)
    return {
      text: truncated,
      resumeData: null,
      parseError: true,
      parseErrorMessage: `Could not structure your background (${result.error || 'unknown'}). Try adding more detail — company names, roles, and what you did.`
    }
  return { text: truncated, resumeData: result.data, parseError: false }
}

// Deterministic — no AI. Renders a structured resumeData object back into
// plain text so the same rule-based ATS scoring engine (ats.service.js) can
// run against brain-dump input exactly as it does against extracted file
// text. This is a formatting step only: it exists because scoreResume()
// expects a plain-text resume with recognizable section headers and bullet
// markers, and raw freeform brain-dump text won't reliably have either.
// Deterministic on purpose — scoring must be reproducible from the same
// structured data every time, with no AI variance in between structuring
// and scoring.
function serializeResumeData(resumeData) {
  const lines = []
  if (resumeData.name) lines.push(resumeData.name)
  // AUDIT FIX (section audit — "generate a resume from scratch"): linkedin/
  // portfolio didn't exist anywhere in this schema before — see
  // claude.service.js's parseResumeStructure/structureFreeformText. Included
  // here on the same contact line as email/phone/location so the rule-based
  // scorer (ats.service.js) sees them in the same header region it already
  // scans for a Contact section, same as a human-written resume would have them.
  const contactParts = [resumeData.email, resumeData.phone, resumeData.location, resumeData.linkedin, resumeData.portfolio].filter(Boolean)
  if (contactParts.length) lines.push(contactParts.join(' | '))
  lines.push('')

  if (resumeData.summary) {
    lines.push('SUMMARY')
    lines.push(resumeData.summary)
    lines.push('')
  }

  if (resumeData.experience?.length) {
    lines.push('EXPERIENCE')
    for (const job of resumeData.experience) {
      const header = [job.title, job.company, job.dates].filter(Boolean).join(' — ')
      if (header) lines.push(header)
      for (const bullet of (job.bullets || [])) lines.push(`- ${bullet}`)
    }
    lines.push('')
  }

  if (resumeData.education?.length) {
    lines.push('EDUCATION')
    for (const edu of resumeData.education) {
      const header = [edu.degree, edu.institution, edu.dates].filter(Boolean).join(' — ')
      if (header) lines.push(header)
    }
    lines.push('')
  }

  if (resumeData.skills?.length) {
    lines.push('SKILLS')
    lines.push(resumeData.skills.join(', '))
    lines.push('')
  }

  if (resumeData.certifications?.length) {
    lines.push('CERTIFICATIONS')
    for (const cert of resumeData.certifications) lines.push(`- ${cert}`)
    lines.push('')
  }

  // AUDIT FIX (section audit — "generate a resume from scratch"): a Projects
  // section didn't exist anywhere in this pipeline before — see the schema
  // comment on claude.service.js's parseResumeStructure. Specifically
  // significant for brain-dump users with thin formal work history (students,
  // career-changers, self-taught candidates), who often have more to show in
  // projects than in Experience.
  if (resumeData.projects?.length) {
    lines.push('PROJECTS')
    for (const p of resumeData.projects) {
      const header = [p.name, p.technologies?.length ? p.technologies.join(', ') : null].filter(Boolean).join(' — ')
      if (header) lines.push(header)
      if (p.description) lines.push(`- ${p.description}`)
      if (p.link) lines.push(p.link)
    }
  }

  return lines.join('\n')
}

module.exports = { extractText, parse, structureBrainDump, serializeResumeData }
