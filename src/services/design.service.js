const { cleanPaperChoice } = require('../lib/paperChoice')
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

// Paper size. The product's customers apply to US and UK employers (and across Africa and Europe): US Letter is
// 8.5x11in and is used in the US and Canada; almost everywhere else uses A4. A page of the wrong size is rescaled by the
// print dialog, so the page is chosen from the posting - unless the person chose one (resolvePaper): signals for A4
// (UK spelling, a pound / euro sign, a UK / Irish / European / African / Gulf / Asia-Pacific place name, "UK") are weighed
// against signals for Letter ("US", a US state or "City, ST", Canada and its provinces, 401(k), EEO wording); A4 wins only
// when it has MORE signals, so a posting that is truly ambiguous ("US and UK customers") stays Letter, the US default.
// Scan/ATS round 12: the old rule gave A4 to any posting that said "London", "Manchester" or "Birmingham" - Birmingham AL,
// Manchester NH and London, Ontario - and "UK" anywhere, and gave Letter to Dublin, Berlin or Nairobi.
const US_STATES = 'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming'
const CA_PROVINCES = 'ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland'
const US_ABBR = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC'
const CA_ABBR = 'ON|QC|BC|AB|MB|SK|NS|NB|NL'
// Places that exist on both sides of the Atlantic: counted for A4 only when NOT followed by a US state / Canadian province.
const AMBIGUOUS_CITIES = 'london|manchester|birmingham|glasgow|bristol|cardiff|belfast|edinburgh|leeds|durham|cambridge|oxford|reading|hamilton|perth|sydney|richmond|portland|lancaster|plymouth|newcastle|dover|bath|windsor'
const A4_WORDS = new RegExp(String.raw`\b(?:organis(?:e|ed|ing|ation|ations)|programme|programmes|colour|centre|centres|specialis(?:e|ed|ing|ation)|licence|behaviour|analyse|analysed|recognis(?:e|ed)|optimis(?:e|ed|ation)|prioritis(?:e|ed)|judgement|enrolment|fulfil|favour|labour|catalogue|whilst|curriculum vitae|nhs|united kingdom|england|scotland|wales|northern ireland|ireland|dublin|germany|berlin|munich|france|paris|netherlands|amsterdam|spain|madrid|barcelona|italy|milan|rome|switzerland|zurich|geneva|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|poland|warsaw|portugal|lisbon|belgium|brussels|austria|vienna|europe|emea|kenya|nairobi|mombasa|nigeria|lagos|abuja|ghana|accra|south africa|johannesburg|cape town|uganda|kampala|tanzania|dar es salaam|rwanda|kigali|ethiopia|egypt|cairo|morocco|india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|pakistan|australia|new zealand|singapore|uae|dubai|abu dhabi|saudi arabia|riyadh|qatar|doha)\b|£|€`, 'gi')
const A4_UK_CAPS = /\bUK\b/g
const CITY_RE = new RegExp(String.raw`\b(${AMBIGUOUS_CITIES})\b(?!\s*,\s*(?:${US_STATES}|${CA_PROVINCES}|${US_ABBR}|${CA_ABBR})\b)`, 'gi')
const LETTER_WORDS = new RegExp(String.raw`\b(?:united states|usa|u\.s\.a?\.?|america|american|canada|canadian|mexico|${US_STATES}|${CA_PROVINCES}|401\(k\)|eeo|equal opportunity employer|w-2|h-1b|us citizen(?:ship)?)\b`, 'gi')
const LETTER_US_CAPS = /\bUS\b/g
const LETTER_CITY_STATE = new RegExp(String.raw`\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s(?:${US_ABBR}|${CA_ABBR})\b`, 'g')
const count = (re, s) => (s.match(re) || []).length
function detectPaper(jdText) {
  const t = String(jdText || '')
  if (!t.trim()) return 'letter'
  // "Birmingham, Alabama" is Letter, not A4: the state / province after an ambiguous city is also a Letter signal.
  const a4 = count(A4_WORDS, t) + count(A4_UK_CAPS, t) + count(CITY_RE, t)
  const letter = count(LETTER_WORDS, t) + count(LETTER_US_CAPS, t) + count(LETTER_CITY_STATE, t)
  return a4 > letter ? 'a4' : 'letter'
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
// What the person chose ('letter' | 'a4'; anything else = Auto) wins over the guess.
function resolvePaper(explicit, jdText) { return cleanPaperChoice(explicit) || detectPaper(jdText) }
const isUkSpelling = jdText => (String(jdText || '').match(/\b(?:organis\w+|programme\w*|colour\w*|centre\w*|specialis\w+|licence|behaviour\w*|analyse\w*|optimis\w+|prioritis\w+|judgement|whilst)\b/gi) || []).length >= 2

// ── Look versions ────────────────────────────────────────────────────────────────────────────────────────────────
// A document's colours and type are re-derived every time it is rendered, so the rules that derive them are part of every
// delivered file. They are therefore VERSIONED (scans.doc_template_version, migration 0101) and a version's rules are never
// edited once a document has been delivered with them - change the look by adding a version.
//   1  the original free draw from PALETTES x FONTS (frozen below: PALETTES, FONTS and INDUSTRY above are version 1's tables,
//      and tests/docTemplate.test.js pins what they produce)
//   2  the signature presets: one fixed skeleton (pdfTemplate.service.js / docx.service.js), a handful of designed looks
const LATEST_LOOK = 2

// Version 2. A preset fixes the type (pairing and size) and the range of inks; the role category - already detected from the
// posting and stored on the scan - decides which preset a document gets, so nothing here is random per document and nothing
// asks a model. Inside a preset the ink is chosen from the PERSON (their id), so one person's resume and cover letters, and
// every scan they run, read as the same set, while two people in one field do not all share a colour.
const PRESETS = {
  // Law, finance, education: serif headings, restrained ink.
  traditional:  { label: 'Traditional',  font: 'classic',   palettes: ['navy', 'slate', 'midnight', 'graphite', 'charcoal'] },
  // The default: clean sans headings, calm blues and greens. Healthcare, operations, sales, product and anything undetected.
  professional: { label: 'Professional', font: 'clean',     palettes: ['clinical', 'ocean', 'teal', 'navy', 'sage', 'slate'] },
  // Engineering and data: a tighter technical sans.
  modern:       { label: 'Modern',       font: 'tech',      palettes: ['ocean', 'teal', 'midnight', 'violet', 'charcoal'] },
  // Design and marketing: serif headings, warmer ink.
  creative:     { label: 'Creative',     font: 'editorial', palettes: ['plum', 'wine', 'coral', 'terracotta', 'rose', 'copper'] },
}
const PRESET_BY_CATEGORY = {
  legal: 'traditional', finance: 'traditional', education: 'traditional',
  software_engineering: 'modern', data_science: 'modern',
  design: 'creative', marketing: 'creative',
  healthcare: 'professional', operations: 'professional', sales: 'professional', product_management: 'professional',
}
const presetFor = industry => PRESET_BY_CATEGORY[industry] || 'professional'

// The version a stored value means: 1 (the original look) for a scan from before the column, a missing or unknown value.
function resolveLook(v) {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= LATEST_LOOK ? n : 1
}

function getDesignTokens(userId, scanId, industry = 'default', { jdText = '', paper = null, version = 1 } = {}) {
  const look = resolveLook(version)
  if (look === 2) {
    const id = presetFor(industry)
    const preset = PRESETS[id]
    const palettes = preset.palettes.map(pid => PALETTES.find(p => p.id === pid))
    const font = FONTS.find(f => f.id === preset.font)
    return {
      palette: palettes[djb2(`look2:${id}:${userId || scanId || 'anon'}`) % palettes.length],
      fonts:   font,
      paper:   resolvePaper(paper, jdText),
      preset:  id,
      version: 2
    }
  }
  // Version 1 - FROZEN. Do not edit this branch or the tables it reads.
  const seed     = djb2((userId || 'anon') + scanId)
  const allowed  = INDUSTRY[industry] || null
  const filtered = allowed ? PALETTES.filter(p => allowed.includes(p.id)) : PALETTES
  return {
    palette: filtered[seed % filtered.length],
    // A second, independent hash for the font: indexing both lists with the SAME number made
    // the pair follow gcd(palettes, fonts) — only a fraction of palette/font combinations ever occurred.
    fonts:   FONTS[djb2(`font:${userId || 'anon'}${scanId}`) % FONTS.length],
    paper:   resolvePaper(paper, jdText)
  }
}

module.exports = { getDesignTokens, resolveLook, presetFor, LATEST_LOOK, PRESETS, PRESET_BY_CATEGORY, PALETTES, FONTS, detectPaper, paperForLocation, resolvePaper, cleanPaperChoice, isUkSpelling, PAPER: { letter: { format: 'Letter', css: 'Letter', width: '8.5in', minHeight: '9.85in', docx: { width: 12240, height: 15840 } }, a4: { format: 'A4', css: 'A4', width: '210mm', minHeight: '268mm', docx: { width: 11906, height: 16838 } } } }
