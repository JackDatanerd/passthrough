const PALETTES = [
  { id:'clinical',   bg:'#FFFFFF', primary:'#1E40AF', accent:'#E2E8F0', text:'#1F2937' },
  { id:'forest',     bg:'#FFFFFF', primary:'#166534', accent:'#DCFCE7', text:'#14532D' },
  { id:'terracotta', bg:'#FFFFFF', primary:'#9A3412', accent:'#FED7AA', text:'#431407' },
  { id:'slate',      bg:'#FFFFFF', primary:'#475569', accent:'#E2E8F0', text:'#0F172A' },
  { id:'plum',       bg:'#FFFFFF', primary:'#7C3AED', accent:'#EDE9FE', text:'#2E1065' },
  { id:'gold',       bg:'#FFFFFF', primary:'#B45309', accent:'#FDE68A', text:'#451A03' },
  { id:'rose',       bg:'#FFFFFF', primary:'#BE123C', accent:'#FCE7F3', text:'#4C0519' },
  { id:'teal',       bg:'#FFFFFF', primary:'#0F766E', accent:'#CCFBF1', text:'#134E4A' },
  { id:'midnight',   bg:'#FFFFFF', primary:'#1E1B4B', accent:'#E0E7FF', text:'#1E1B4B' },
  { id:'copper',     bg:'#FFFFFF', primary:'#92400E', accent:'#FDE8D8', text:'#1C0A00' },
  { id:'sage',       bg:'#FFFFFF', primary:'#2D6A4F', accent:'#D8F3DC', text:'#1B4332' },
  { id:'navy',       bg:'#FFFFFF', primary:'#1D3461', accent:'#D6E4FF', text:'#0D1B2A' },
  { id:'graphite',   bg:'#FFFFFF', primary:'#374151', accent:'#F3F4F6', text:'#111827' },
  { id:'wine',       bg:'#FFFFFF', primary:'#831843', accent:'#FCE7F3', text:'#500724' },
  { id:'ocean',      bg:'#FFFFFF', primary:'#0369A1', accent:'#BAE6FD', text:'#0C4A6E' },
  { id:'amber',      bg:'#FFFFFF', primary:'#B45309', accent:'#FEF3C7', text:'#451A03' },
  { id:'charcoal',   bg:'#FFFFFF', primary:'#111827', accent:'#E5E7EB', text:'#111827' },
  { id:'violet',     bg:'#FFFFFF', primary:'#5B21B6', accent:'#EDE9FE', text:'#2E1065' },
  { id:'coral',      bg:'#FFFFFF', primary:'#C53030', accent:'#FED7D7', text:'#63171B' },
]

const FONTS = [
  { id:'classic',   heading:'Merriweather',        body:'Source+Sans+3',     hPt:24, bPt:10.5 },
  { id:'modern',    heading:'Playfair+Display',     body:'Inter',             hPt:22, bPt:10   },
  { id:'clean',     heading:'Raleway',              body:'Open+Sans',         hPt:23, bPt:10.5 },
  { id:'editorial', heading:'Libre+Baskerville',    body:'Lato',              hPt:22, bPt:10   },
  { id:'tech',      heading:'Space+Grotesk',        body:'DM+Sans',           hPt:23, bPt:10   },
  { id:'refined',   heading:'Cormorant+Garamond',   body:'Nunito',            hPt:26, bPt:10.5 },
  { id:'precise',   heading:'Josefin+Sans',         body:'Mulish',            hPt:22, bPt:10   },
  { id:'warm',      heading:'Crimson+Text',         body:'Source+Sans+3',     hPt:25, bPt:11   },
]

// Conservative fields get restrained ink colours only; everything else may use the full set. Keys are the
// role_category values detectRoleCategory produces.
const INDUSTRY = {
  healthcare: ['clinical','slate','teal','ocean','midnight'],
  legal:      ['slate','navy','midnight','charcoal','graphite'],
  finance:    ['slate','navy','midnight','graphite','charcoal'],
  education:  ['navy','slate','midnight','sage','graphite'],
  operations: ['slate','navy','graphite','charcoal','midnight'],
}

function djb2(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i) | 0
  return Math.abs(h)
}

// Paper size. The product's customers apply to US and UK employers: US Letter is 8.5x11in, the UK / Ireland /
// Europe use A4. A Letter-sized page printed on A4 (or the reverse) is rescaled by the print dialog, so the
// page is chosen from the posting: UK-spelling words, a pound sign or a UK/Irish place name -> A4, anything
// else -> Letter (the US default).
const UK_MARKERS = /\b(?:organis(?:e|ed|ing|ation|ations)|programme|programmes|colour|centre|centres|specialis(?:e|ed|ing|ation)|licence|behaviour|analyse|analysed|recognis(?:e|ed)|optimis(?:e|ed|ation)|prioritis(?:e|ed)|judgement|enrolment|fulfil|favour|labour|catalogue|whilst|curriculum vitae|nhs|uk|united kingdom|england|scotland|wales|northern ireland|london|manchester|birmingham|edinburgh|glasgow|leeds|bristol|cardiff|belfast|ireland)\b|£/gi
function detectPaper(jdText) {
  const hits = String(jdText || '').match(UK_MARKERS)
  return hits && hits.length >= 1 && !/\b(?:united states|usa|u\.s\.|new york|california|texas)\b/i.test(String(jdText)) ? 'a4' : 'letter'
}
// Paper for a document that has no job posting to read it from (the saved-profile download): the applicant's own
// location line. US / Canada / a few Latin-American and Philippine markets use Letter, nearly everywhere else A4. null when
// the location says nothing either way — the caller keeps its default (Letter, like detectPaper).
const LETTER_PLACES = /\b(?:united states|u\.?s\.?a?\.?|america|canada|mexico|chile|colombia|venezuela|philippines|dominican republic|costa rica|panama|guatemala|puerto rico)\b|,\s*(?:A[LKZR]|C[AOT]|D[C]|F[L]|G[A]|H[I]|I[LAN]|K[SY]|L[A]|M[AINSOT]|N[EVHJMYCD]|O[HKR]|P[A]|R[I]|S[CD]|T[NX]|U[T]|V[AT]|W[AVIY]|O[N]|Q[C]|B[C]|A[B]|M[B]|N[S])\s*$/
const A4_PLACES = /\b(?:united kingdom|uk|england|scotland|wales|northern ireland|ireland|kenya|uganda|tanzania|rwanda|ethiopia|nigeria|ghana|south africa|zambia|zimbabwe|egypt|morocco|india|pakistan|bangladesh|sri lanka|australia|new zealand|singapore|malaysia|uae|dubai|saudi arabia|qatar|germany|france|spain|italy|netherlands|belgium|sweden|norway|denmark|finland|poland|portugal|switzerland|austria|brazil|argentina|turkey|nairobi|mombasa|kisumu|kampala|lagos|accra|johannesburg|cape town|london|dublin|paris|berlin|amsterdam)\b/i
function paperForLocation(location) {
  const t = String(location || '').trim()
  if (!t) return null
  // A bare two-letter code is only read as a state/province when it follows a comma (", TX"); "IN", "DE" and "ID" are left out
  // because they are as often India, Germany and Indonesia (A4) as Indiana, Delaware and Idaho.
  const stateCode = /,\s*([A-Z]{2})\s*$/.exec(t)
  if (stateCode && !['IN', 'DE', 'ID'].includes(stateCode[1]) && LETTER_PLACES.test(t)) return 'letter'
  if (/\b(?:united states|u\.?s\.?a?\.?|america|canada|mexico|chile|colombia|venezuela|philippines|dominican republic|costa rica|panama|guatemala|puerto rico)\b/i.test(t)) return 'letter'
  return A4_PLACES.test(t) ? 'a4' : null
}
const isUkSpelling = jdText => (String(jdText || '').match(/\b(?:organis\w+|programme\w*|colour\w*|centre\w*|specialis\w+|licence|behaviour\w*|analyse\w*|optimis\w+|prioritis\w+|judgement|whilst)\b/gi) || []).length >= 2

function getDesignTokens(userId, scanId, industry = 'default', { jdText = '' } = {}) {
  const seed     = djb2((userId || 'anon') + scanId)
  const allowed  = INDUSTRY[industry] || null
  const filtered = allowed ? PALETTES.filter(p => allowed.includes(p.id)) : PALETTES
  return {
    palette: filtered[seed % filtered.length],
    // A second, independent hash for the font: indexing both lists with the SAME number made the
    // pair follow gcd(palettes, fonts) — only a fraction of palette/font combinations ever occurred.
    fonts:   FONTS[djb2(`font:${userId || 'anon'}${scanId}`) % FONTS.length],
    paper:   detectPaper(jdText)
  }
}

module.exports = { getDesignTokens, detectPaper, paperForLocation, isUkSpelling, PAPER: { letter: { format: 'Letter', css: 'Letter', width: '8.5in', minHeight: '9.85in', docx: { width: 12240, height: 15840 } }, a4: { format: 'A4', css: 'A4', width: '210mm', minHeight: '268mm', docx: { width: 11906, height: 16838 } } } }
