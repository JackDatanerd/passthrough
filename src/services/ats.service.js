const constants = require('../config/constants')
const { decodeHtmlEntities } = require('../lib/htmlEntities')

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','was','are','were','be','been','have','has','had',
  'will','would','could','should','may','might','this','that','these',
  'those','it','its','we','you','they','them','their','our','do','does',
  'did','not','as','so','if','about','than','into','over','also',
  // Job-posting boilerplate — these dominate JD word-frequency counts but
  // no resume should ever need to contain them literally. Before this list
  // was expanded, words like "your", "role", "apply", and "provide" were
  // routinely showing up in "missing keywords" and dragging scores down for
  // reasons that had nothing to do with resume quality.
  'your','you','role','job','apply','applying','please','ensure','provide',
  'provided','including','include','includes','team','teams','work',
  'working','worked','experience','experienced','skills','ability',
  'abilities','strong','excellent','looking','seeking','candidate',
  'candidates','position','opportunity','opportunities','company','join',
  'required','requirements','requires','preferred','years','year','etc',
  'via','across','within','both','more','most','such','each','any','all',
  'some','well','new','using','use','used','various','multiple','related',
  'based','ideal','must','need','needs','responsible','responsibilities',
  'duties','tasks','environment','plus','benefits','salary','pay','hourly',
  'remote','onsite','hybrid','full','time','part','listed','ago','id',
  'click','copy','link','platform','host','hosted'
])

// Lightweight heuristic stemmer — NOT a full Porter/Snowball stemmer, but
// covers the inflections that actually matter for resume/JD matching:
// plurals (-s/-es/-ies), gerunds (-ing), past tense (-ed), agent nouns
// (-er/-or) and -ment (so "manager", "managers", "managed", "managing" and
// "management" all meet at one stem, as do "engineer"/"engineers"/
// "engineering").
//
// AUDIT FIX (Auth/Scan round): this used to pick exactly ONE suffix rule
// (an else-if chain), so the plural was never removed before the agent-noun
// rule ran. "manager" -> "manag" but "managers" -> "manager"; "customer" ->
// "custom" but "customers" -> "customer"; "engineering" -> "engineer" but
// "engineer" -> "engin". Of 35 common agent nouns, 29 failed to match their
// own plural, so a JD asking for "engineers" scored ZERO against a resume
// saying "engineer" (and the reverse) — up to 35 points of keyword score lost
// for identical wording. Rules now run in order on the same word: plural
// first, then the verb/agent/-ment suffixes, then a trailing "e".
//
// Deliberately still NOT full derivational morphology ("coordination" won't
// meet "coordinate").
function stem(word) {
  if (PROTECTED_TOKENS.has(word)) return word
  let w = word
  // 1. plural
  if (w.length > 4 && w.endsWith('ies'))                          w = w.slice(0, -3) + 'y'
  else if (w.length > 5 && /(?:ch|sh|x|z|ss)es$/.test(w))         w = w.slice(0, -2)
  else if (w.length > 4 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1)
  // 2. derivational suffixes, applied to the singular form
  if (w.length > 5 && w.endsWith('ational')) w = w.slice(0, -5)
  if (w.length > 6 && w.endsWith('ization')) w = w.slice(0, -4)
  if (w.length > 6 && w.endsWith('ment'))    w = w.slice(0, -4)
  const before = w
  if (w.length > 5 && w.endsWith('ing'))      w = w.slice(0, -3)
  else if (w.length > 5 && w.endsWith('ed'))  w = w.slice(0, -2)
  // "planning" -> "plann" -> "plan", "programming" -> "program" (but never
  // "adding" -> "ad", or "installing" -> "instal": l/s/z/f and short stems are exempt)
  if (w.length > 5 && (w.endsWith('er') || w.endsWith('or'))) w = w.slice(0, -2)
  if (w !== before && w.length > 4 && /([bdgmnprt])\1$/.test(w)) w = w.slice(0, -1)
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

// ── Tech-term handling ──────────────────────────────────────────────────────
// The tokenizer used to be `replace(/[^a-z0-9\s]/g, ' ')` plus a "length >= 3"
// filter. Together those made the terms that matter MOST on technical JDs
// invisible: "C++" and "C#" collapsed to a 1-letter token and vanished, ".NET"
// became "net", "CI/CD" became "ci"+"cd" (both dropped), and every 2-letter
// term — ML, AI, QA, UX, UI, BI, JS — was discarded outright. A JD asking for
// all of them produced a keyword list of only the surrounding filler words, so
// missing skills were never reported and present ones earned no credit.
//
// Fix: symbol-bearing terms are rewritten to plain-alphanumeric canonical
// tokens BEFORE tokenizing (applied identically to the resume and the JD, so
// they still match each other), and a curated allowlist of short terms is
// kept. Canonical tokens are mapped back to their real spelling for display.
const CANONICAL_DISPLAY = {
  cplusplus: 'C++', csharp: 'C#', fsharp: 'F#', dotnet: '.NET', cicd: 'CI/CD',
  objectivec: 'Objective-C', rlang: 'R', golang: 'Go', clang: 'C',
}
// Two-letter terms worth keeping as keywords. Deliberately NOT included:
// "it", "pm", "go", "or" and friends that are ordinary English words — the
// language names R / Go / C are handled by the context-aware rules below.
const SHORT_KEEP = new Set(['ai', 'ml', 'qa', 'ux', 'ui', 'bi', 'js', 'ts', 'db', 'os', 'vr', 'ar', 'hr', 'ci', 'cd'])
const PROTECTED_TOKENS = new Set([...Object.keys(CANONICAL_DISPLAY), ...SHORT_KEEP])

// A list-ish position: start of line, or right after , ; : / ( | • * -
const LIST_PREV = String.raw`(?<=(?:^|[,;:/(|•·*\-])[ \t]*)`

function normalizeTechTerms(text) {
  return decodeHtmlEntities(String(text ?? ''))
    .replace(/\bobjective[\s-]c\b/gi, ' objectivec ')
    .replace(/\b(node|next|vue|react|express|nuxt|angular|ember|d3|three)\.?js\b/gi, ' $1 js ')
    .replace(/\bc\+\+/gi, ' cplusplus ')
    .replace(/\bc#/gi, ' csharp ')
    .replace(/\bf#/gi, ' fsharp ')
    // ".NET" the framework — but NOT the TLD of a domain or e-mail address.
    // "john@example.net", "portfolio.net" and "www.acme.net/jobs" used to mint a
    // phantom `dotnet` token, crediting (or, on a JD, demanding) a skill nobody
    // named. ASP.NET / VB.NET still count; a bare ".NET" must stand alone.
    .replace(/\b(?:asp|vb)\.net\b/gi, ' dotnet ')
    .replace(/(?<![\w@.\/-])\.net\b(?!\/)/gi, ' dotnet ')
    .replace(/\bci\s*\/\s*cd\b/gi, ' cicd ')
    .replace(/\bgolang\b/gi, ' golang ')
    // Case-SENSITIVE on purpose: only the capitalised, standalone language
    // names, and only where the surrounding punctuation says "this is a list
    // of skills" — so "Go to market", "R&D", "Plan C" and "Jane R. Doe" are
    // not misread as programming languages.
    .replace(new RegExp(LIST_PREV + String.raw`Go(?=[ \t]*(?:[,;:/)|]|$)|[ \t]+(?:and|or|&)[ \t])`, 'gm'), ' golang ')
    // BUG FIX (Scan/ATS section audit): unlike the Go pattern immediately
    // above (whose lookahead explicitly includes `|$`), this lookahead only
    // ever matched a following delimiter — so "C" as the LAST item in a list
    // ("Skills: Go, R, C", "Required: C++, C") was silently left as a bare,
    // un-normalized "C" and then dropped entirely by keepToken() (single
    // letters aren't kept unless allowlisted), meaning the extremely common
    // case of C being the final language named in a list never counted as a
    // match on either side (resume or JD). Added the same end-of-line/
    // end-of-string alternative Go already had.
    .replace(new RegExp(LIST_PREV + String.raw`C(?=[ \t]*(?:[,;:/)|]|$))`, 'gm'), ' clang ')
    // "... Go and R." — a sentence-final R is still the language when it sits in
    // a list ("," / "and" / "or" / "/" before it); a bare "R. " is otherwise
    // treated as a middle initial ("Jane R. Doe").
    .replace(/(?<=(?:[,;:/(&]|\b(?:and|or))[ \t]*)R(?=\.?(?:[ \t]|$))/gm, ' rlang ')
    .replace(/(?<![\w.+#])R(?![\w+#]|\.\s|\s*[&/]\s*[Dd]\b)/g, ' rlang ')
}

function tokenizeRaw(text) {
  return normalizeTechTerms(text)
    .toLowerCase()
    // Unicode-aware: the old [^a-z0-9] class turned "ingénieur" into the two
    // fragments "ing" + "nieur" and mangled every non-English JD.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

// Punctuation that separates one phrase from the next. A JD bigram must sit INSIDE one of
// these segments: tokenizing strips the punctuation, so "Python, Kubernetes, Docker" used to
// yield the "phrases" "python kubernetes" and "kubernetes docker" — list neighbours, not terms —
// and a resume that said "Docker and Kubernetes" was then docked for "missing" them (and the
// nonsense showed up in "Why this score"). Applied to the JD side only: the resume side stays
// permissive (any two adjacent words), so a real compound term is still found wherever it sits.
const PHRASE_BREAK = /[\n\r,;:|•·()[\]{}<>\\/]|\s[-\u2013\u2014]\s|[.!?](?=\s|$)/u
function tokenizeSegments(text) {
  return normalizeTechTerms(text)
    .toLowerCase()
    .split(PHRASE_BREAK)
    .map(seg => seg.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean))
    .filter(seg => seg.length)
}

// BUG FIX (Scan/ATS pass, verified): any 3+ character token was kept, so a
// posting's pay line ("$120,000 - $150,000"), a year ("2024") or a postcode
// became keywords — the top "missing" list for that JD started with `000`,
// `120`, `150`, `2024`, `10001` and `120 000`. Those can never legitimately
// appear as a skill on a resume, they inflated the keyword denominator (35%
// of the total score) and they put junk in the "Why this score" panel.
// Purely numeric tokens are now dropped (mixed tokens like "s3", "3d", "b2b"
// and "k8s" are unaffected), along with pay-line boilerplate words.
const keepToken = w => (w.length >= 3 || SHORT_KEEP.has(w)) && !/^\p{N}+$/u.test(w)
for (const w of ['per', 'range', 'base', 'hiring', 'annual', 'annually', 'transparency', 'compensation']) STOP_WORDS.add(w)

function displayKeyword(kw) {
  return kw.split(' ').map(t => CANONICAL_DISPLAY[t] || t).join(' ')
}

// Extracts both single-word and adjacent-word-pair ("bigram") candidates
// from a JD, ranked together by frequency. Bigrams catch compound terms
// (e.g. "quality assurance", "machine learning") that single-word
// extraction would split into two separate, less meaningful words.
function extractKeywords(text) {
  const freq = {}
  for (const seg of tokenizeSegments(text)) {
    for (const w of seg) {
      if (keepToken(w) && !STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1
    }
  }
  for (const seg of tokenizeSegments(text)) {
    for (let i = 0; i < seg.length - 1; i++) {
      const a = seg[i], b = seg[i + 1]
      if (keepToken(a) && keepToken(b) && !STOP_WORDS.has(a) && !STOP_WORDS.has(b)) {
        const phrase = `${a} ${b}`
        freq[phrase] = (freq[phrase] || 0) + 1
      }
    }
  }
  return freq
}

// AUDIT FIX: bigrams and unigrams used to be ranked together in one shared
// frequency list. A bigram's count can never exceed its rarest constituent
// word's count, and ties were broken by object-key insertion order (all
// unigrams inserted before any bigram) — so unigrams systematically won
// both on raw frequency AND on ties, meaning the "top 25" was effectively
// always unigrams-only in practice, and the whole point of extracting
// bigrams (catching compound terms like "machine learning" or "quality
// assurance" that splitting into single words would dilute or misrepresent)
// almost never actually happened. Ranking the two pools separately and
// reserving real slots for each guarantees bigrams actually show up when
// the JD has them, instead of only in the rare case they happen to out-
// frequency every single word too.
const TOP_UNIGRAMS = 18
const TOP_BIGRAMS  = 7

// ─── JD zoning (Scan/ATS round 3, B1 + G5) ───────────────────────────────────────────────────
// BUG (verified by probe): keywords were ranked by raw frequency with ties broken by position.
// In a real posting almost every term appears once, so "the top 18" was simply the FIRST 18
// words — the title and the company blurb — and every skill listed further down (Node, TypeScript,
// PostgreSQL, Docker, Kubernetes…) was cut. A strong, well-matched resume scored 36 on keywords;
// deleting only the "About <Company>" paragraph moved it to 68 and the total across both the
// pass (75) and badge (80) lines. The posting is now split into zones (company blurb / benefits /
// EEO vs. requirements / responsibilities) and each occurrence is weighted by its zone and by how
// skill-shaped the term is, so what the role actually asks for outranks what the company says
// about itself.
for (const w of ['what', 'who', 'how', 'why', 'own', 'fast', 'growing', 'equal', 'employer', 'employers', 'nice',
                 'emea', 'apac', 'latam', 'usa', 'eeo', 'remote', 'hybrid', 'onsite']) STOP_WORDS.add(w)

const ZONE_WEIGHT = { title: 1.5, req: 1.5, intro: 1, boiler: 0.25 }

// Multi-word headings are specific enough to recognise anywhere — including inside a posting
// fetched from a URL, which arrives flattened onto one line.
const BOILER_PHRASES = /\b(?:about\s+us|about\s+the\s+company|about\s+our\s+company|company\s+overview|who\s+we\s+are|our\s+mission|our\s+story|our\s+values|why\s+(?:join|work)|what\s+we\s+offer|we\s+offer|equal\s+(?:employment\s+)?opportunity|how\s+to\s+apply|application\s+process|life\s+at\s+[A-Z])/i
// Bare "Benefits" / "Perks" / "Compensation" are only a heading when written as one: capitalised, and
// not glued into a sentence. A lowercase "benefits of CI/CD" inside the requirements must not open a
// boilerplate zone and silently demote everything after it (flattened URL text has no line breaks).
const BOILER_CAPS    = /(?:^|[.!?]\s+|\s{2,})(?:Benefits|Perks|Compensation|Our Culture|Our Team)(?:\s+(?:and|&)\s+(?:Perks|Benefits))?(?=\s*[:\n]|\s+[A-Z])/
const BOILER_PROPER  = /\bAbout\s+(?!the\b|this\b|you\b|your\b)[A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*){0,3}/
const REQ_PHRASES    = /\b(?:what\s+you(?:'|’)?ll\s+(?:do|be\s+doing|work\s+on|bring|need)|what\s+you\s+will\s+(?:do|bring|need)|what\s+you\s+bring|what\s+we(?:'|’)?re\s+looking\s+for|key\s+responsibilities|your\s+responsibilities|your\s+role|about\s+the\s+(?:role|job|position)|day[-\s]to[-\s]day|who\s+you\s+are|must[-\s]haves?|nice[-\s]to[-\s]haves?|minimum\s+qualifications|preferred\s+qualifications|basic\s+qualifications|required\s+skills|technical\s+skills|skills\s+(?:and|&)\s+experience)\b/i
// One-word headings only count when they stand alone on their own (short) line.
const BOILER_LINE = /^(?:benefits|perks|compensation|equal opportunity|diversity|about us|about the company|culture|our culture|our team)\b/i
const REQ_LINE    = /^(?:requirements?|qualifications?|responsibilities|skills|the role|the job|duties|essential|desirable|preferred|experience required|you will|you(?:'|’)ll)\b/i

function splitJdZones(text) {
  const src = String(text || '')
  const marks = []
  const push = (index, type) => marks.push({ index, type })
  for (const [re, type] of [[BOILER_PHRASES, 'boiler'], [BOILER_CAPS, 'boiler'], [BOILER_PROPER, 'boiler'], [REQ_PHRASES, 'req']]) {
    const g = new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g')
    for (const m of src.matchAll(g)) push(m.index, type)
  }
  let off = 0
  for (const line of src.split('\n')) {
    const t = line.trim()
    if (t && t.length <= 40 && !/[.!?]$/.test(t)) {
      const at = off + (line.length - line.trimStart().length)
      if (BOILER_LINE.test(t)) push(at, 'boiler')
      else if (REQ_LINE.test(t)) push(at, 'req')
    }
    off += line.length + 1
  }
  marks.sort((a, b) => a.index - b.index)
  // A requirement heading that sits inside the span a boilerplate heading just opened (and vice
  // versa) is fine — the LAST heading wins — but two marks at the same index collapse to one.
  const uniq = []
  for (const m of marks) if (!uniq.length || uniq[uniq.length - 1].index !== m.index) uniq.push(m)

  const zones = []
  const first = uniq.length ? uniq[0].index : src.length
  if (first > 0) {
    const head = src.slice(0, first)
    const nl = head.indexOf('\n')
    const titleEnd = Math.min(nl === -1 ? head.length : nl, 120)
    if (titleEnd > 0) zones.push({ type: 'title', text: head.slice(0, titleEnd) })
    if (head.length > titleEnd) zones.push({ type: 'intro', text: head.slice(titleEnd) })
  }
  uniq.forEach((m, i) => {
    const end = i + 1 < uniq.length ? uniq[i + 1].index : src.length
    zones.push({ type: m.type, text: src.slice(m.index, end) })
  })
  return zones
}

// Terms that are skill-shaped: a curated set of common tools / languages / platforms plus anything
// the posting itself writes as an acronym (SQL, ECS, CRM) or CamelCase product (GraphQL, PostgreSQL).
const TECH_TERMS = new Set(`python java javascript typescript golang rust ruby php swift kotlin scala csharp cplusplus clang rlang
  matlab perl bash sql nosql html css sass node js nodejs react angular vue svelte nextjs nuxt express django flask fastapi spring rails
  laravel dotnet graphql rest restful grpc soap docker kubernetes k8s terraform ansible puppet chef jenkins git github gitlab bitbucket
  aws azure gcp s3 ec2 ecs eks lambda sqs sns kafka rabbitmq redis memcached mongodb postgresql postgres mysql sqlite oracle dynamodb
  cassandra elasticsearch snowflake bigquery redshift databricks spark hadoop airflow dbt tableau powerbi looker excel pandas numpy
  scipy pytorch tensorflow sklearn keras llm nlp devops sre cicd microservices serverless grafana datadog prometheus splunk newrelic
  linux unix windows ios android flutter figma sketch photoshop illustrator salesforce hubspot sap netsuite workday jira confluence
  agile scrum kanban seo sem crm erp etl api apis sdk oauth saml sso jwt ci cd qa selenium cypress jest junit pytest mocha
  idempotency observability monitoring microservice mpesa shopify wordpress magento stripe paypal quickbooks`.split(/\s+/).filter(Boolean))

function skillShapedTokens(text) {
  const out = new Set()
  const add = raw => { for (const t of tokenizeRaw(raw)) out.add(t) }
  for (const m of String(text || '').matchAll(/\b[A-Z]{2,6}\b/g)) add(m[0])
  for (const m of String(text || '').matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) add(m[0])
  for (const m of String(text || '').matchAll(/\b[A-Za-z]+\.js\b/gi)) add(m[0])
  return out
}

function techBonus(token, caps) {
  if (TECH_TERMS.has(token)) return 1.5
  if (caps.has(token)) return 0.75
  if (/\d/.test(token) && /[a-z]/.test(token)) return 0.75
  return 0
}

// Weighted candidate pool: word/phrase -> { weight, order }. extractKeywords() (raw counts) is kept
// for callers that want plain frequency; scoring uses this.
function extractWeightedKeywords(text) {
  const zones = splitJdZones(text)
  const caps = skillShapedTokens(text)
  const pool = new Map()
  let order = 0
  const bump = (key, w) => {
    const e = pool.get(key)
    if (e) e.weight += w
    else pool.set(key, { weight: w, order: order++ })
  }
  for (const z of zones) {
    const zw = ZONE_WEIGHT[z.type] ?? 1
    for (const seg of tokenizeSegments(z.text)) {
      for (const w of seg) {
        if (keepToken(w) && !STOP_WORDS.has(w)) bump(w, zw * (1 + techBonus(w, caps)))
      }
      for (let i = 0; i < seg.length - 1; i++) {
        const a = seg[i], b = seg[i + 1]
        if (keepToken(a) && keepToken(b) && !STOP_WORDS.has(a) && !STOP_WORDS.has(b)) {
          bump(`${a} ${b}`, zw * (1 + Math.max(techBonus(a, caps), techBonus(b, caps)) * 0.5))
        }
      }
    }
  }
  return pool
}

function rankPool(entries, limit) {
  // A word that appears ONLY inside company/benefits boilerplate once carries almost no weight; drop
  // those unless that would leave too little to score against.
  const strong = entries.filter(([, e]) => e.weight >= 0.5)
  const use = strong.length >= Math.min(limit, 8) ? strong : entries
  return use.sort((x, y) => (y[1].weight - x[1].weight) || (x[1].order - y[1].order)).slice(0, limit).map(([w]) => w)
}

// Trim an over-long posting (G5). The old behaviour sliced the first N characters, which is the
// company intro, and threw away the requirements. Boilerplate zones go first; if it still does not
// fit, title + requirement zones are kept ahead of everything else. Short postings are untouched.
function fitJobDescription(text, max) {
  const src = String(text || '')
  if (src.length <= max) return src
  const zones = splitJdZones(src)
  const pri = { title: 0, req: 1, intro: 2, boiler: 3 }
  const ranked = zones.map((z, i) => ({ ...z, i })).sort((a, b) => (pri[a.type] - pri[b.type]) || (a.i - b.i))
  const kept = []
  let used = 0
  // Company / benefits / EEO text is context, not signal: keep a little of it (so the posting still
  // reads as itself) but never let it crowd out the role, however long it is.
  const boilerCap = Math.max(300, Math.floor(max * 0.15))
  let boilerUsed = 0
  for (const z of ranked) {
    const room = max - used
    if (room <= 0) break
    let piece = z.text.length > room ? z.text.slice(0, room) : z.text
    if (z.type === 'boiler') {
      const allowed = boilerCap - boilerUsed
      if (allowed <= 0) continue
      if (piece.length > allowed) piece = piece.slice(0, allowed)
      boilerUsed += piece.length
    }
    kept.push({ ...z, text: piece })
    used += piece.length + 1
  }
  if (!kept.length) return src.slice(0, max)
  return kept.sort((a, b) => a.i - b.i).map(z => z.text.trim()).join('\n').slice(0, max)
}

// ── SCAN/ATS ROUND 4: keyword integrity ───────────────────────────────────────────────────────────────────
// A keyword used to count if the word appeared ANYWHERE in the resume. That made the free score — and through it the
// "Passthrough Verified" credential — cheap to inflate: one extra line of skills (measured: a 62 became an 88 on the
// rule layer, past the 80 credential line) or the job description pasted in white. Three deterministic guards, each
// of which leaves an honest resume exactly as it scored before:
//   1. SKILLS-ONLY. A JD term found only in the Skills list, with none of it evidenced in a role, a project or the
//      summary, earns less — but only when MOST of the matches are like that (a stuffed list, not a normal one).
//   2. COPIED TEXT. Five-word runs that appear in both the resume and the posting. Honest resumes share a few by chance;
//      a pasted posting shares dozens.
//   3. HIDDEN TEXT. The ingest layer dropped white/tiny/off-page/"hidden" text and counted it; trying it is penalised.
const SKILLS_HEADING_RE  = /(?:^| )(?:skills|technical skills|core competencies|competencies|expertise|technologies|tools|tech stack|competences|competencias|habilidades|aptitudes|kenntnisse|fahigkeiten|fertigkeiten)(?: |$)/
const OTHER_HEADING_RE   = /(?:^| )(?:experience|work history|employment history|professional experience|education|academic background|summary|professional summary|objective|profile|projects|personal projects|certifications?|certificates|awards|languages|volunteer(?:ing)?|publications|interests|references|experiencia|formacion|educacion|resumen|perfil|berufserfahrung|ausbildung|zusammenfassung|formation|parcours professionnel|emploi)(?: |$)/
const foldHeading = l => l.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z& ]+/g, ' ').replace(/\s+/g, ' ').trim()
const LINK_BLOCK_MARK = '[hyperlinks in this document]'
function stripLinkBlock(text) {
  const i = String(text || '').indexOf(LINK_BLOCK_MARK)
  return i === -1 ? text : text.slice(0, i)
}
// Splits a resume into the lines that SAY what the person did (roles, projects, summary…) and the lines of its skills
// list. With no recognisable Skills heading everything is evidence — the old behaviour.
function resumeEvidenceZones(text) {
  const evidence = [], skills = []
  let zone = 'header'
  for (const line of String(text || '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    const inline = t.match(/^(?:technical\s+)?skills?\s*[:\u2013-]\s*(.+)$/i)
    if (inline) { skills.push(inline[1]); continue }
    if (t.length <= 50 && !/[.!?]$/.test(t) && t.split(/\s+/).length <= 6) {
      const f = foldHeading(t)
      if (SKILLS_HEADING_RE.test(f)) { zone = 'skills'; continue }
      if (OTHER_HEADING_RE.test(f))  { zone = 'body'; continue }
    }
    if (zone === 'skills' && !(t.split(/\s+/).length >= 10 && /[.]$/.test(t))) skills.push(t)
    else if (zone !== 'header' || t.length >= 60) evidence.push(t)
  }
  return { evidence: evidence.join('\n'), skills: skills.join('\n'), hasSkillsZone: skills.length > 0 }
}
const shingles = (text, n = 5) => {
  const w = String(text || '').toLowerCase().replace(/[^a-z0-9+#.\s]/g, ' ').split(/\s+/).filter(Boolean)
  const out = new Set()
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
  return out
}
const stemSets = text => {
  const tokens = tokenizeRaw(text)
  const stems = new Set(tokens.map(stem))
  const bigrams = new Set()
  for (let i = 0; i < tokens.length - 1; i++) bigrams.add(`${stem(tokens[i])} ${stem(tokens[i + 1])}`)
  return { stems, bigrams }
}
const HIDDEN_TEXT_MIN = 20

function scoreKeywords(resumeText, jdText, { hiddenTextChars = 0 } = {}) {
  const pool = extractWeightedKeywords(jdText)
  const entries = [...pool.entries()]
  const topUnigrams = rankPool(entries.filter(([w]) => !w.includes(' ')), TOP_UNIGRAMS)
  const topBigrams  = rankPool(entries.filter(([w]) => w.includes(' ')), TOP_BIGRAMS)
  const top25 = [...topUnigrams, ...topBigrams]

  // Match against STEMMED resume tokens, not a raw substring search — this
  // is what actually lets "managed"/"managing"/"manager" in the resume credit a
  // JD's "management" (well, "manage" — see stemmer limitations above), instead
  // of requiring an exact literal string match.
  const zones = resumeEvidenceZones(resumeText)
  const all = stemSets(resumeText)
  const ev  = zones.hasSkillsZone ? stemSets(zones.evidence) : all
  const has = (sets, kw) => {
    if (kw.includes(' ')) { const [a, b] = kw.split(' '); return sets.bigrams.has(`${stem(a)} ${stem(b)}`) }
    return sets.stems.has(stem(kw))
  }
  const matched = top25.filter(kw => has(all, kw))
  const missing = top25.filter(kw => !matched.includes(kw))
  const skillsOnly = matched.filter(kw => !has(ev, kw))

  const warnings = []
  const stuffed = zones.hasSkillsZone && skillsOnly.length >= 6 && skillsOnly.length >= 0.6 * matched.length
  const skillsOnlyWeight = stuffed ? 0.4 : 1
  if (stuffed) warnings.push(`${skillsOnly.length} of the ${matched.length} job-description terms appear only in a skills list and nowhere in your roles or projects — they count for less until your experience shows them`)

  let copiedRatio = 0
  if (jdText) {
    const rs = shingles(zones.hasSkillsZone ? `${zones.evidence}\n${zones.skills}` : resumeText)
    if (rs.size >= 30) {
      const js = shingles(jdText)
      let shared = 0
      for (const sh of rs) if (js.has(sh)) shared++
      copiedRatio = shared / rs.size
      if (shared >= 15 && copiedRatio >= 0.12) warnings.push('large parts of your resume repeat the job description word for word — write what you actually did in your own words')
    }
  }
  const copied = copiedRatio >= 0.12 && warnings.some(w => w.startsWith('large parts'))
  const hidden = hiddenTextChars >= HIDDEN_TEXT_MIN
  if (hidden) warnings.push('hidden text was found in the file (white, tiny, off-page or "hidden"-formatted words)')

  let score = null
  if (top25.length) {
    const weight = matched.reduce((sum, kw) => sum + (skillsOnly.includes(kw) ? skillsOnlyWeight : 1), 0)
    let raw = (weight / top25.length) * 100
    if (copied || hidden) raw *= 0.5
    score = Math.round(raw)
  }
  return {
    // null (not 100) when the JD yielded nothing to match — a posting made only of filler words
    // used to hand out a perfect keyword score, 35 free points. scoreResume() re-weights.
    score,
    // Canonical tokens (cplusplus, dotnet, ...) are internal — show users the
    // real spelling (C++, .NET, ...).
    detail: {
      matched: matched.map(displayKeyword),
      missing: missing.map(displayKeyword),
      matchRate: top25.length ? matched.length / top25.length : null,
      noKeywords: top25.length === 0,
      warnings,
      integrity: { skillsOnly: skillsOnly.length, stuffed, copiedRatio: Math.round(copiedRatio * 1000) / 1000, hiddenTextChars }
    }
  }
}

// Grounded in standard published resume-writing action-verb categories
// (leadership, achievement/results, communication, analysis, technical,
// financial, creative, organizational, research, training) rather than an
// arbitrary short list. The previous 44-word set meant any bullet using a
// perfectly legitimate, strong verb that simply wasn't on that short list
// — "Wrote", "Authored", "Conducted", "Tested", "Reviewed", "Supervised",
// "Engineered", dozens of others — got zero credit, which is very likely
// the dominant reason Content scores were landing in the 30s-40s even on
// genuinely well-written resumes.
const ACTION_VERBS = new Set([
  // Leadership / management
  'led','lead','managed','directed','supervised','oversaw','coordinated','headed',
  'chaired','spearheaded','orchestrated','guided','mentored','coached',
  'delegated','empowered','championed','cultivated','fostered','governed',
  'steered','piloted','captained','commanded','administered',
  // Achievement / results
  'achieved','exceeded','surpassed','attained','delivered','accomplished',
  'completed','secured','won','earned','generated','realized','fulfilled',
  'outperformed',
  // Communication
  'communicated','presented','negotiated','persuaded','authored','wrote',
  'drafted','edited','published','briefed','liaised','consulted','advised',
  'counseled','articulated','conveyed','pitched','reported','documented',
  'summarized','translated',
  // Creation / building
  'built','created','developed','designed','engineered','constructed',
  'established','founded','formulated','devised','invented','architected',
  'launched','initiated','pioneered','introduced','crafted','composed',
  'produced','shaped','conceived',
  // Improvement / optimization
  'improved','enhanced','streamlined','optimized','upgraded','refined',
  'revamped','modernized','simplified','accelerated','boosted',
  'strengthened','elevated','transformed','overhauled','restructured',
  // Reduction / efficiency
  'reduced','cut','decreased','minimized','eliminated','consolidated',
  'downsized','saved','trimmed',
  // Analysis / research
  'analyzed','evaluated','assessed','audited','investigated','researched',
  'examined','diagnosed','identified','interpreted','modeled','forecasted',
  'calculated','quantified','measured','benchmarked','synthesized',
  'validated','verified',
  // Operations / process
  'implemented','executed','operated','maintained','monitored','tracked',
  'processed','facilitated','standardized','automated','integrated',
  'deployed','migrated','configured','managed','scheduled','planned',
  'organized','prioritized',
  // Financial
  'budgeted','allocated','funded','financed','invested','forecasted',
  'audited','reconciled',
  // Training / teaching
  'trained','taught','educated','instructed','onboarded','tutored',
  'coached',
  // Team / collaboration
  'collaborated','partnered','contributed','supported','assisted',
  'volunteered',
  // Technical
  'programmed','coded','tested','debugged','architected','automated',
  'provisioned','deployed',
  // Growth / sales / business
  'grew','expanded','scaled','drove','closed','converted','acquired',
  'negotiated','onboarded','retained',
  // Recognition
  'awarded','recognized','honored','selected',
  // Restored from the original list (accidentally dropped when this set
  // was reorganized by category) + a few other very common resume verbs
  // that were missing from any category above
  'increased','resolved','owned','shipped','handled','performed',
  'conducted','reviewed','hired','recruited',
  // Common irregular past-tense forms (stemming can't bridge these to their
  // base form, so they're listed explicitly rather than relying on -ed)
  'sold','brought','taught','sought','bought','caught','chose','dealt',
  'felt','knew','spent','stood','understood','went','met','sat','spoke',
  'wrote','drove','ran','began','held','kept','set','cut','grew'
])

// Precomputed once at module load, not per-bullet-check — stemmed lookup
// lets tense/inflection variants of a listed verb (e.g. "Leading" for
// "Led", "Manages" for "Managed") get credit too, not just an exact string
// match against the past-tense form.
const ACTION_VERB_STEMS = new Set([...ACTION_VERBS].map(stem))

// AUDIT FIX (Auth/Scan round): the bullet-glyph class was •, -, *, ◦, ▪, ‣, ·.
// Word/PDF exports commonly produce others — ● ○ ■ – — ➢ ➤ ✓ and, from
// Symbol/Wingdings list fonts, the private-use glyphs U+F0B7 / U+F0A7. A
// resume using any of them had ZERO recognised bullets, so Content scored 0
// (a 16-point swing on the overall score, measured). One shared set now
// feeds both the style-consistency check and the content scorer.
const BULLET_GLYPHS = '•●○◦▪▫■□◆◇►▸▶➢➤➔✓✔–—·∙‣⁃\\-\\*\\uf0b7\\uf0a7\\uf076\\uf0d8\\uf0fc'
const BULLET_START = new RegExp(`^\\s*[${BULLET_GLYPHS}]`, 'mg')
const BULLET_LINE  = new RegExp(`^\\s*(?:[${BULLET_GLYPHS}]|[0-9]+[.)]|[A-Za-z][.)])\\s`)
// Glyphs that are the same visual style collapse to one "type" for the
// inconsistent-bullet check (an extractor turning • into U+F0B7 is not the
// author mixing styles).
function bulletFamily(ch) {
  if ('•●∙·\uf0b7\uf0a7\uf076\uf0d8\uf0fc'.includes(ch)) return '•'
  if ('-–—'.includes(ch)) return '-'
  if ('○◦'.includes(ch)) return '○'
  if ('■□▪▫'.includes(ch)) return '■'
  return ch
}

function scoreFormat(resumeText, structure = null) {
  if (!resumeText || resumeText.trim().length < 100)
    return { score: 0, detail: { issues: ['Resume could not be parsed'] } }
  let score = 100; const issues = []
  // REMOVED: a "count | characters, flag if >5" table-detection check used
  // to live here. Removed after direct testing proved it has no real
  // detection value in either direction: a genuine DOCX table (<w:tbl>)
  // produces ZERO pipe characters under our own jszip-based extractor —
  // table cells just become separate lines, like any other paragraph — so
  // this check could never actually catch a real table. Meanwhile it
  // reliably false-positived on the extremely common, ATS-safe "Company |
  // Location | Dates" formatting convention, silently costing otherwise
  // well-formatted resumes 15 points for no real reason. A check that only
  // ever fires incorrectly is worse than no check. Genuine table detection
  // would need to inspect the raw DOCX XML for <w:tbl> presence before
  // extraction discards that structure — a real future improvement, but a
  // meaningfully different (and bigger) change than tuning this heuristic.
  const bTypes = new Set((resumeText.match(BULLET_START) || []).map(b => bulletFamily(b.trim()[0])))
  if (bTypes.size > 2)
    { score -= 15; issues.push('Inconsistent bullet style') }
  // AUDIT FIX: this fired on ordinary, well-formatted single-column resumes.
  // Both resume.parser.js's DOCX extractor and this app's OWN docx.service.js
  // generator emit one line per paragraph/bullet with no regard for visual
  // wrapping (Word doesn't hard-wrap; wrapping is display-only) — a single
  // detailed bullet or a 2-3 sentence professional summary routinely exceeds
  // 200 characters as ONE line. Since this scorer's own Content category
  // explicitly rewards specific, detailed bullets, a well-optimized (or
  // AI-rewritten-by-this-app) resume was MORE likely to trip this and lose
  // 15 points for a formatting problem it didn't have — the same class of
  // false-positive the adjacent table-detection check was already removed
  // for (see comment above). A genuine multi-column PDF-extraction garble
  // concatenates whole paragraphs from two columns into one line and tends
  // to run much longer than any single legitimate bullet/summary line —
  // raising both the length and count bar keeps some signal for that real
  // case while no longer firing on normal detailed writing.
  if (resumeText.split('\n').filter(l => l.length > 400).length > 5)
    { score -= 15; issues.push('Possible multi-column layout') }
  // STRUCTURE (the genuine table / text-box detection the note above called a
  // "real future improvement"): resume.parser.js inspects the raw DOCX XML before
  // extraction flattens it, and passes the counts in. Each of these is a widely
  // documented way employer ATS parsers lose or scramble content, and none is
  // visible in the extracted text. Absent for PDFs and generated documents.
  if (structure && typeof structure === 'object') {
    if (structure.textBoxes > 0)
      { score -= 15; issues.push('Content inside text boxes — many ATS parsers skip text boxes entirely') }
    if (structure.tables > 0)
      { score -= structure.tables >= 3 ? 20 : 10; issues.push('Table-based layout — some ATS parsers read tables out of order or drop them') }
    if (structure.columns > 1)
      { score -= 15; issues.push('Multi-column page layout — text may be read across columns instead of down them') }
    if (structure.images > 0)
      { score -= 5; issues.push('Images or graphics — ATS parsers ignore them, so nothing in them counts') }
    // SCAN/ATS ROUND 4: facts only the ingest layer can see (see pdf.inspect.js / resume.parser.js).
    if (structure.hiddenTextChars >= HIDDEN_TEXT_MIN)
      { score -= 25; issues.push('Hidden text — white, tiny, off-page or "hidden"-formatted words. We ignored it; ATS systems and recruiters treat it as keyword stuffing, so remove it') }
    if (structure.imageOnly)
      { score -= 60; issues.push('Image-only PDF — it has no real text, so an employer ATS reads it as a blank page. Rebuild it from a Word or Google Docs export') }
  }
  return { score: Math.max(0, score), detail: { issues } }
}

function scoreSections(resumeText) {
  const lower = resumeText.toLowerCase()
  const required = [
    // English first, then the common section words of French / Spanish / Portuguese / German
    // resumes (diacritics are folded away before matching, so "Expérience" is "experience").
    { name: 'Experience', patterns: ['experience','work history','employment history','experiencia','experiencias','berufserfahrung','erfahrung','parcours professionnel','emploi','emplois'] },
    { name: 'Education',  patterns: ['education','academic background','formation','formations','formacion','educacion','formacao','educacao','ausbildung','bildung','studium','parcours academique'] },
    { name: 'Skills',     patterns: ['skills','technical skills','core competencies','expertise','competences','competencias','habilidades','aptitudes','kenntnisse','fahigkeiten','fertigkeiten'] },
    { name: 'Contact',    patterns: null },
  ]
  // Certifications was previously weighted equally with Summary as one of
  // two "optional" sections worth 15 points each — but Certifications is
  // genuinely field-dependent (most candidates legitimately have none),
  // while Summary is near-universal in modern professional resumes. Equal
  // weighting meant most complete, well-formatted resumes silently capped
  // at 85/100 for lacking something most people don't have, with no
  // indication why — `missing` only ever tracked required sections, so
  // this 15-point loss wasn't even visible to the user. Certifications is
  // still tracked below for informational purposes, just no longer
  // penalized numerically.
  const summaryPatterns  = ['summary','objective','profile','profil','perfil','resumen','objectif','objetivo','sintese','zusammenfassung','kurzprofil']
  const certPatterns     = ['certification','certifications','certificates','licenses','licences','awards']
  // AUDIT FIX (section audit — "generate a resume from scratch"): Projects
  // is new to the schema (see claude.service.js) and, like Certifications,
  // genuinely field-dependent — most candidates with solid formal Experience
  // won't have one, while it's often the strongest section for exactly the
  // brain-dump users this section serves (students, career-changers,
  // self-taught candidates). Tracked for informational purposes only, same
  // non-penalizing treatment as hasCertifications below.
  const projectPatterns = ['projects','personal projects','side projects']

  // AUDIT FIX: was slice(0, 10) — a header with name/phone/LinkedIn/
  // portfolio/GitHub each on their own line (common) can push the email
  // past line 10, wrongly flagging "Contact" as a missing section on a
  // resume that has one. Widened to 20 lines, still well short of where
  // real body content (Experience/Education) would start.
  const lines20  = lower.split('\n').slice(0, 20).join(' ')
  const hasEmail = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/.test(lines20)

  // AUDIT FIX (Auth/Scan round): every section used to be detected with
  // lower.includes('experience') / ('education') / ('skills') / ('profile') /
  // ('objective') anywhere in the text — so a resume with NO section headings
  // at all scored 100% ("years of experience", "strong education", "my
  // skills", "LinkedIn profile" in ordinary prose each counted as a whole
  // section) and the "missing sections" feedback could essentially never fire
  // for its real target: ATS parsers segment a resume by its headings. A
  // section now counts when a short heading-shaped LINE carries the word.
  // Text with no line structure (a single-line extraction) keeps the old
  // substring behaviour rather than reporting every section missing.
  const rawLines = resumeText.split('\n')
  const structured = rawLines.filter(l => l.trim()).length >= 6
  const headings = rawLines
    .map(l => l.trim())
    .filter(l => l && l.length <= 50 && !/[.!?]$/.test(l) && !/^\d/.test(l) && !/\byears?\b/i.test(l))
    .map(l => l.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z& ]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(l => l && l.split(' ').length <= 6)
  const hasSection = patterns => structured
    ? headings.some(h => patterns.some(pt => new RegExp(`(?:^| )${pt}(?: |$)`).test(h)))
    : patterns.some(pt => lower.includes(pt))

  const foundReq = required.filter(s => s.patterns ? hasSection(s.patterns) : hasEmail)
  const hasSummary  = hasSection(summaryPatterns)
  const hasCerts    = hasSection(certPatterns)
  const hasProjects = hasSection(projectPatterns)

  return {
    score: Math.min(100, Math.round((foundReq.length / 4) * 85 + (hasSummary ? 15 : 0))),
    detail: {
      found:   foundReq.map(s => s.name).concat(hasSummary ? ['Summary'] : []),
      missing: required.filter(s => !foundReq.includes(s)).map(s => s.name),
      // Informational only — doesn't affect score. Present so the UI/
      // rewrite feedback can still mention it as an optional improvement
      // without implying its absence is a real problem.
      hasCertifications: hasCerts,
      hasProjects
    }
  }
}

// English function words: a resume in English is full of them, one in another language is not. Two-letter words that
// other languages also use ("a", "in", "on") are left out so they cannot make a Spanish or German resume look English.
const EN_FUNCTION_WORDS = new Set(['the', 'and', 'of', 'to', 'for', 'with', 'by', 'is', 'as', 'at', 'from', 'that', 'this', 'using', 'are', 'was', 'into', 'across', 'through', 'their', 'our', 'also', 'which', 'while'])
function looksEnglish(text) {
  const words = String(text || '').toLowerCase().match(/[a-z\u00c0-\u024f]+/g) || []
  if (words.length < 60) return true
  let hits = 0
  for (const w of words) if (EN_FUNCTION_WORDS.has(w)) hits++
  return hits / words.length >= 0.05
}

function scoreContent(resumeText) {
  // Symbolic bullets (•, -, *, ◦, etc.) need no trailing punctuation — the
  // bullet character followed by a space IS the complete marker. Only
  // alphanumeric markers (numbered/lettered lists) need a trailing "." or
  // ")" to distinguish "1. Did X" from an unrelated sentence starting with
  // a digit or letter (e.g. "3D printing", "A great year").
  //
  // The previous regex required [.)] after EVERY character in the class,
  // including the symbolic ones — which meant it only ever matched numbered
  // lists ("1. ", "1) ") and silently failed to recognize plain "• "/"- "/
  // "* " bullets, by far the most common resume bullet style. That made
  // Content scoring collapse to near-zero on most normally-formatted
  // resumes, independent of extraction method or file type.
  // AUDIT FIX: the numbered/lettered-list branch was `[0-9A-Za-z]+[.)]` —
  // unbounded length, so it matched far more than the "1." / "a)" style
  // markers the comment above (and the surrounding design intent) describes.
  // Any line starting with a period-abbreviated word — "Sr. Software
  // Engineer", "Dr. Jane Smith" — matched too, inflating the bullet-count
  // denominator with lines that were never bullets, diluting
  // actionVerbRate for reasons unrelated to actual bullet quality. Split
  // into digits-of-any-length ("1.", "12)") or a SINGLE letter ("a)", "A.")
  // — real numbered/lettered list markers are always one of these two
  // shapes, while every common title/name abbreviation ("Sr.", "Dr.",
  // "Mr.", "St.") is 2+ letters and no longer matches.
  let bullets = resumeText.split('\n').filter(l => BULLET_LINE.test(l))
  // AUDIT FIX (Auth/Scan round): when the source format carries NO bullet
  // characters at all (a DOCX whose list numbering isn't text, a PDF whose
  // bullet glyphs the extractor dropped) fewer than 3 marked lines are found
  // in a resume that plainly has bullet-style lines, and the score collapsed
  // to 0. Fall back to substantial sentence-like lines below the header block.
  if (bullets.length < 3) {
    const candidates = resumeText.split('\n').slice(6)
      .map(l => l.trim())
      .filter(l => l.length >= 30 && l.length <= 500 && /^[A-Z]/.test(l) && l.split(/\s+/).length >= 5 && !/[:]$/.test(l))
    if (candidates.length >= 3) bullets = candidates
  }
  const total   = bullets.length || 1
  const actionCount = bullets.filter(b => {
    const words = b.trim().replace(BULLET_LINE, '').trim().toLowerCase().split(/\s+/)
    return words.length > 0 && ACTION_VERB_STEMS.has(stem(words[0]))
  }).length
  // SCAN/ATS ROUND 4: the action-verb list is English. Section detection is multilingual, so a French or Spanish
  // resume was recognised as a resume and then scored ~0 on Content for not starting bullets with English verbs
  // (measured: 80 in English, 9 in Spanish — about 14 points off the total). For a resume that is not in English the
  // verb check is skipped and given the benefit of the doubt; everything else (numbers, length) still applies.
  const nonEnglish = !looksEnglish(resumeText)
  let score = nonEnglish ? 75 : Math.round((actionCount / total) * 100)
  // AUDIT FIX: this only matched digit-THEN-unit order (e.g. "50%", "50k"),
  // which silently missed the standard US currency format where the symbol
  // comes first — "$50,000", "$1,500,000" — since the comma also breaks the
  // \d+ run before it ever reaches a trailing $/k/m/million/thousand token.
  // Added a second alternative for $-prefixed numbers (comma/decimal-
  // tolerant) so spelled-out dollar figures count as quantification just
  // like "50%" or "50k" already did.
  const quantifiedCount = (resumeText.match(/\d+\s*(%|\$|k\b|m\b|million|thousand)|\$\s*\d[\d,]*(\.\d+)?/gi) || []).length
  if (quantifiedCount >= 2) score = Math.min(100, score + 10)
  const wordCount = resumeText.split(/\s+/).filter(Boolean).length
  if (wordCount < 200) score = Math.max(0, score - 20)
  if (/references available/i.test(resumeText)) score = Math.max(0, score - 10)
  // Bullets that say what was done but not how much — the single most useful thing a person can fix by hand, and
  // previously only visible to someone who had already paid for a rewrite.
  const bulletText = b => b.trim().replace(BULLET_LINE, '').trim()
  const unquantified = bullets.filter(b => !/\d/.test(b) && bulletText(b).split(/\s+/).length >= 6)
  return {
    score,
    detail: {
      actionVerbRate: nonEnglish ? null : actionCount / total,
      quantifiedCount,
      language: nonEnglish ? 'other' : 'en',
      unquantified: { count: unquantified.length, total: bullets.length, examples: unquantified.slice(0, 5).map(b => bulletText(b).slice(0, 160)) },
      issues: nonEnglish ? ['The action-verb check only reads English, so it was skipped for this resume'] : []
    }
  }
}

// AUDIT FIX (Auth/Scan round): detectRoleCategory returned the FIRST category
// whose keyword appeared ANYWHERE in the JD as a raw substring, in map order.
// "engineer"/"software" are checked first, so a Product Manager JD that says
// "partner with engineers" was software_engineering, a nurse JD mentioning
// "charting software" likewise, and 'ops' matched "desktops"/"workshops".
// This value feeds employer-lead supply counts, so those mislabels leak into
// what employers are told. Now: whole-word matches, scored per category with
// heavy weight on the title area (first ~200 chars) and only light weight
// (capped) on body mentions; non-software engineering disciplines are not
// software; a category needs a minimum score or the answer is 'other'.
const NON_SOFTWARE_ENGINEER = '(?:civil|mechanical|electrical|chemical|structural|industrial|biomedical|manufacturing|hardware|field|sales|process|mining|petroleum|environmental|quality|network|audio|systems?)\\s+'
const ROLE_SIGNALS = {
  software_engineering: [`(?<!${NON_SOFTWARE_ENGINEER})engineer`, 'developer', 'programmer', 'software', 'backend', 'back-end', 'frontend', 'front-end', 'full.?stack', 'devops', 'sre'],
  product_management:   ['product manager', 'product owner', 'product management', 'roadmap', 'sprint'],
  design:               ['designer', 'ui/ux', 'ux', 'figma', 'user experience', 'visual design'],
  data_science:         ['data scientist', 'machine learning', 'data analyst', 'data science', 'data engineer'],
  marketing:            ['marketing', 'growth marketing', 'seo', 'content marketing', 'content strategy', 'copywriter', 'social media', 'brand'],
  sales:                ['sales(?!force)', 'account executive', 'business development', 'quota', 'account manager'],
  operations:           ['operations', 'ops', 'supply chain', 'logistics', 'project manager', 'program manager'],
  finance:              ['finance', 'accounting', 'accountant', 'financial analyst', 'audit', 'bookkeep'],
  healthcare:           ['nurse', 'nursing', 'doctor', 'physician', 'clinical', 'medical', 'patient'],
  legal:                ['lawyer', 'attorney', 'paralegal', 'legal counsel', 'legal'],
  education:            ['teacher', 'professor', 'instructor', 'curriculum', 'lecturer'],
}
const ROLE_REGEXES = Object.fromEntries(Object.entries(ROLE_SIGNALS).map(([cat, kws]) => [
  cat, kws.map(k => new RegExp(`\\b${k}${/^[a-z]+$/.test(k) && k.length <= 3 ? '\\b' : ''}`, 'g')),
]))
function detectRoleCategory(jdText) {
  const lower = String(jdText || '').toLowerCase()
  const title = lower.trim().slice(0, 200)
  let best = 'other', bestScore = 0
  for (const [cat, regexes] of Object.entries(ROLE_REGEXES)) {
    let score = 0
    for (const re of regexes) {
      re.lastIndex = 0
      if (re.test(title)) score += 10
      re.lastIndex = 0
      score += Math.min((lower.match(re) || []).length, 2)
    }
    if (score > bestScore) { best = cat; bestScore = score }
  }
  return bestScore >= 2 ? best : 'other'
}

// AUDIT FIX (Auth/Scan round): the old detector (a) never matched "Sr."/"Jr."
// because `\b(sr\.)\b` needs a word character AFTER the dot, and (b) looked
// at the whole JD, so "reports to the VP of Sales" made an account-manager
// role 'executive' and "works with the Director of Engineering" made an
// engineer 'lead'. The level now comes from the title area (first ~200
// chars); the body is consulted only for an explicit years-of-experience
// requirement, and never for reporting-line mentions.
const SENIORITY_PATTERNS = [
  ['executive', /\b(?:vp|vice president|cto|ceo|coo|cfo|cmo|chief)\b/],
  // "staff" is a level only in front of a technical/managerial title ("Staff Engineer"); "Staff
  // Nurse" / "Staff Accountant" / "staff of 40" are not.
  ['lead',      /\b(?:head of|director|principal|lead)\b(?!\s+gen)|\bstaff\s+(?:\w+\s+)?(?:engineer|developer|scientist|designer|architect|researcher|programmer|swe|sre|product|program|data|machine|software)\b/],
  ['senior',    /\b(?:senior|sr)\b/],
  // "Associate" is a junior level in most fields but a mid/senior rank for attorneys, professors
  // and partners, so those never read as junior.
  ['junior',    /\b(?:junior|jr|entry.?level|intern(?:ship)?|graduate|trainee|apprentice)\b|\bassociate\b(?!\s+(?:attorney|lawyer|counsel|professor|dean|partner|general|vice|principal|director|judge|justice))/],
]
// "reports to the VP of Sales" / "works closely with the Director of X" name
// somebody ELSE's level, not the role's own.
const OTHER_PERSON_CLAUSE = /\b(?:report(?:s|ing)?(?:\s+directly)?\s+to|(?:work(?:s|ing)?|partner(?:s|ing)?|collaborat\w+)(?:\s+closely)?\s+with)\b[^.;\n]{0,60}/g
// Years-of-experience requirement, read only where it is plainly a requirement:
// "N years" (or "N-M years", "N+ years") followed by experience wording, or
// introduced by minimum / at least / requires. The first "N years" anywhere used
// to win, so "Founded 25 years ago ... requires 3 years" made a mid role senior
// and "2-5 years" made a mid role junior.
const YEARS_RE = /(\d{1,2})\s*\+?\s*(?:(?:-|\u2013|to)\s*(\d{1,2})\s*\+?\s*)?years?\b/g
function requiredYears(lower) {
  for (const m of lower.matchAll(YEARS_RE)) {
    const after  = lower.slice(m.index + m[0].length, m.index + m[0].length + 60)
    const before = lower.slice(Math.max(0, m.index - 30), m.index)
    if (/^\s*(?:ago|old|in business|of age|since)\b/.test(after)) continue
    if (/\b(?:founded|established|for over|for more than|over the (?:past|last))\s*(?:the\s*)?$/.test(before)) continue
    if (!/experience|exp\b|background|hands.on|proven|track record|working|professional|industry/.test(after) &&
        !/(?:minimum|min\.?|at least|requires?|required)\s*(?:of\s*)?$/.test(before)) continue
    const lo = parseInt(m[1], 10)
    const hi = m[2] ? parseInt(m[2], 10) : lo
    return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) }
  }
  return null
}
function detectSeniority(jdText) {
  const lower = String(jdText || '').toLowerCase()
  const title = lower.trim().slice(0, 200).replace(OTHER_PERSON_CLAUSE, ' ')
  for (const [level, re] of SENIORITY_PATTERNS) if (re.test(title)) return level
  const y = requiredYears(lower)
  if (y) {
    if (y.lo >= 8) return 'senior'
    if (y.hi <= 2) return 'junior'
  }
  return 'mid'
}

function scoreResume(resumeText, jdText, { structure = null } = {}) {
  // The ingest layer appends the file's link targets after the text; they are not resume prose and must not be scored as it.
  resumeText = stripLinkBlock(resumeText)
  const kw  = scoreKeywords(resumeText, jdText, { hiddenTextChars: structure?.hiddenTextChars || 0 })
  const fmt = scoreFormat(resumeText, structure)
  const sec = scoreSections(resumeText)
  const cnt = scoreContent(resumeText)
  // A JD with no scoreable keywords says nothing about keyword fit: the category is dropped and
  // the other three carry its weight (0.65 total), instead of scoring 100 or 0 on nothing. The
  // reported keywordScore is then the same re-weighted blend so the four numbers still add up.
  let keywordScore = kw.score
  let score
  if (keywordScore === null) {
    const other = (fmt.score * 0.25 + sec.score * 0.20 + cnt.score * 0.20) / 0.65
    keywordScore = Math.round(other)
    score = other
  } else {
    score = kw.score * 0.35 + fmt.score * 0.25 + sec.score * 0.20 + cnt.score * 0.20
  }
  score = Math.max(0, Math.min(100, Math.round(score)))
  return {
    score,
    passed:        score >= constants.ATS_PASS_THRESHOLD,
    badgeEligible: score >= constants.ATS_BADGE_THRESHOLD,
    keywordScore,
    formatScore:   fmt.score,
    sectionsScore: sec.score,
    contentScore:  cnt.score,
    detail: {
      keywords: kw.detail,
      format:   fmt.detail,
      sections: sec.detail,
      content:  cnt.detail
    }
  }
}

// Translates a scoreResume() result into concrete, human-readable notes for
// a rewrite retry prompt — "your score was low" gives Claude nothing to act
// on, but "keyword match is 40%, missing: kubernetes, terraform" does.
function describeWeakAreas(scoreResult) {
  const notes = []
  if (scoreResult.keywordScore < 70) {
    const missing = (scoreResult.detail?.keywords?.missing || []).slice(0, 8)
    notes.push(`keyword match is only ${scoreResult.keywordScore}% — work in these JD terms naturally where truthful: ${missing.join(', ') || '(see JD)'}`)
  }
  if (scoreResult.contentScore < 70) {
    const rate = scoreResult.detail?.content?.actionVerbRate
    notes.push(`content score is ${scoreResult.contentScore} — ${rate < 0.7 ? 'more bullets need to open with a strong action verb' : 'bullets need more specific, concrete detail'}; add quantification wherever the user actually gave you a number to work with`)
  }
  if (scoreResult.sectionsScore < 90) {
    const missing = scoreResult.detail?.sections?.missing || []
    if (missing.length) notes.push(`missing expected section(s): ${missing.join(', ')}`)
  }
  if (scoreResult.formatScore < 90) {
    const issues = scoreResult.detail?.format?.issues || []
    if (issues.length) notes.push(`formatting issues: ${issues.join('; ')}`)
  }
  return notes.length ? notes : ['overall score below target — strengthen keyword alignment and bullet specificity throughout']
}

module.exports = {
  splitJdZones,
  extractWeightedKeywords,
  fitJobDescription,
  scoreResume, detectRoleCategory, detectSeniority, describeWeakAreas,
  // exported for tests
  extractKeywords, stem, tokenizeRaw, normalizeTechTerms, displayKeyword, scoreFormat, requiredYears,
  resumeEvidenceZones, looksEnglish, stripLinkBlock
}
