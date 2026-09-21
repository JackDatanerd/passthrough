const constants = require('../config/constants')

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
// plurals (-s/-ies), gerunds (-ing), past tense (-ed), and agent nouns
// (-er/-or, so "developer" matches "develop", "manager" matches "manage").
// This deliberately doesn't attempt full derivational morphology (e.g.
// "management" won't stem to match "manage") — that's a much harder
// problem, and this covers the large majority of real-world cases at a
// fraction of the complexity. Verified against 12+ common word-pair tests
// plus a false-positive check against common English words before shipping.
function stem(word) {
  let w = word
  if (w.length > 5 && w.endsWith('ational')) w = w.slice(0, -5)
  if (w.length > 6 && w.endsWith('ization')) w = w.slice(0, -4)
  if (w.length > 5 && w.endsWith('ies'))      w = w.slice(0, -3) + 'y'
  else if (w.length > 5 && (w.endsWith('er') || w.endsWith('or'))) w = w.slice(0, -2)
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 5 && w.endsWith('ed'))  w = w.slice(0, -2)
  else if (w.length > 5 && w.endsWith('es'))  w = w.slice(0, -2)
  else if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

function tokenizeRaw(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
}

// Extracts both single-word and adjacent-word-pair ("bigram") candidates
// from a JD, ranked together by frequency. Bigrams catch compound terms
// (e.g. "quality assurance", "machine learning") that single-word
// extraction would split into two separate, less meaningful words.
function extractKeywords(text) {
  const raw = tokenizeRaw(text)
  const freq = {}
  for (const w of raw) {
    if (w.length >= 3 && !STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1
  }
  for (let i = 0; i < raw.length - 1; i++) {
    const a = raw[i], b = raw[i + 1]
    if (a.length >= 3 && b.length >= 3 && !STOP_WORDS.has(a) && !STOP_WORDS.has(b)) {
      const phrase = `${a} ${b}`
      freq[phrase] = (freq[phrase] || 0) + 1
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

function scoreKeywords(resumeText, jdText) {
  const freq = extractKeywords(jdText)
  const unigramEntries = Object.entries(freq).filter(([w]) => !w.includes(' '))
  const bigramEntries  = Object.entries(freq).filter(([w]) => w.includes(' '))
  const topUnigrams = unigramEntries.sort((a, b) => b[1] - a[1]).slice(0, TOP_UNIGRAMS).map(([w]) => w)
  const topBigrams  = bigramEntries.sort((a, b) => b[1] - a[1]).slice(0, TOP_BIGRAMS).map(([w]) => w)
  const top25 = [...topUnigrams, ...topBigrams]

  // Match against STEMMED resume tokens, not a raw substring search — this
  // is what actually lets "managed"/"managing"/"manager" in the resume
  // credit a JD's "management" (well, "manage" — see stemmer limitations
  // above), instead of requiring an exact literal string match.
  const resumeTokens = tokenizeRaw(resumeText)
  const resumeStems  = new Set(resumeTokens.map(stem))
  const resumeBigramStems = new Set()
  for (let i = 0; i < resumeTokens.length - 1; i++) {
    resumeBigramStems.add(`${stem(resumeTokens[i])} ${stem(resumeTokens[i + 1])}`)
  }

  const matched = top25.filter(kw => {
    if (kw.includes(' ')) {
      const [a, b] = kw.split(' ')
      return resumeBigramStems.has(`${stem(a)} ${stem(b)}`)
    }
    return resumeStems.has(stem(kw))
  })
  const missing = top25.filter(kw => !matched.includes(kw))
  return {
    score: top25.length ? Math.round((matched.length / top25.length) * 100) : 100,
    detail: { matched, missing, matchRate: top25.length ? matched.length / top25.length : 1 }
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

function scoreFormat(resumeText) {
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
  const bTypes = new Set((resumeText.match(/^[\s]*[•\-\*◦▪‣·]/mg) || []).map(b => b.trim()[0]))
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
  return { score: Math.max(0, score), detail: { issues } }
}

function scoreSections(resumeText) {
  const lower = resumeText.toLowerCase()
  const required = [
    { name: 'Experience', patterns: ['experience','work history','employment history'] },
    { name: 'Education',  patterns: ['education','academic background'] },
    { name: 'Skills',     patterns: ['skills','technical skills','core competencies','expertise'] },
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
  const summaryPatterns = ['summary','objective','profile']
  const certPatterns    = ['certification','licenses','awards']

  // AUDIT FIX: was slice(0, 10) — a header with name/phone/LinkedIn/
  // portfolio/GitHub each on their own line (common) can push the email
  // past line 10, wrongly flagging "Contact" as a missing section on a
  // resume that has one. Widened to 20 lines, still well short of where
  // real body content (Experience/Education) would start.
  const lines20  = lower.split('\n').slice(0, 20).join(' ')
  const hasEmail = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/.test(lines20)
  const foundReq = required.filter(s => s.patterns ? s.patterns.some(p => lower.includes(p)) : hasEmail)
  const hasSummary = summaryPatterns.some(p => lower.includes(p))
  const hasCerts   = certPatterns.some(p => lower.includes(p))

  return {
    score: Math.min(100, Math.round((foundReq.length / 4) * 85 + (hasSummary ? 15 : 0))),
    detail: {
      found:   foundReq.map(s => s.name).concat(hasSummary ? ['Summary'] : []),
      missing: required.filter(s => !foundReq.includes(s)).map(s => s.name),
      // Informational only — doesn't affect score. Present so the UI/
      // rewrite feedback can still mention it as an optional improvement
      // without implying its absence is a real problem.
      hasCertifications: hasCerts
    }
  }
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
  const BULLET_LINE = /^\s*(?:[•\-\*◦▪‣·]|[0-9]+[.)]|[A-Za-z][.)])\s/
  const bullets = resumeText.split('\n').filter(l => BULLET_LINE.test(l))
  const total   = bullets.length || 1
  const actionCount = bullets.filter(b => {
    const words = b.trim().replace(BULLET_LINE, '').trim().toLowerCase().split(/\s+/)
    return words.length > 0 && ACTION_VERB_STEMS.has(stem(words[0]))
  }).length
  let score = Math.round((actionCount / total) * 100)
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
  return {
    score,
    detail: { actionVerbRate: actionCount / total, quantifiedCount, issues: [] }
  }
}

function detectRoleCategory(jdText) {
  const lower = jdText.toLowerCase()
  const map = {
    software_engineering: ['engineer','developer','programmer','software','backend','frontend','devops'],
    product_management:   ['product manager','product owner','roadmap','sprint'],
    design:               ['designer','ui/ux','figma','user experience'],
    data_science:         ['data scientist','machine learning','data analyst'],
    marketing:            ['marketing','growth','seo','content','brand'],
    sales:                ['sales','account executive','business development','revenue'],
    operations:           ['operations','ops','supply chain','logistics','project manager'],
    finance:              ['finance','accounting','financial analyst','audit'],
    healthcare:           ['nurse','doctor','clinical','medical','patient'],
    legal:                ['lawyer','attorney','legal','compliance'],
    education:            ['teacher','professor','instructor','curriculum'],
  }
  for (const [cat, kws] of Object.entries(map))
    if (kws.some(k => lower.includes(k))) return cat
  return 'other'
}

function detectSeniority(jdText) {
  const lower = jdText.toLowerCase()
  if (/\b(vp|vice president|cto|ceo|coo|chief)\b/.test(lower)) return 'executive'
  if (/\b(head of|director|principal|staff engineer)\b/.test(lower)) return 'lead'
  if (/\b(senior|sr\.)\b/.test(lower)) return 'senior'
  if (/\b(junior|jr\.|entry.?level|associate|intern)\b/.test(lower)) return 'junior'
  return 'mid'
}

function scoreResume(resumeText, jdText) {
  const kw  = scoreKeywords(resumeText, jdText)
  const fmt = scoreFormat(resumeText)
  const sec = scoreSections(resumeText)
  const cnt = scoreContent(resumeText)
  const score = Math.max(0, Math.min(100, Math.round(
    kw.score * 0.35 + fmt.score * 0.25 + sec.score * 0.20 + cnt.score * 0.20
  )))
  return {
    score,
    passed:        score >= constants.ATS_PASS_THRESHOLD,
    badgeEligible: score >= constants.ATS_BADGE_THRESHOLD,
    keywordScore:  kw.score,
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

module.exports = { scoreResume, detectRoleCategory, detectSeniority, describeWeakAreas }
