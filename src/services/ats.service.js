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

function scoreKeywords(resumeText, jdText) {
  const freq  = extractKeywords(jdText)
  const top25 = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w)

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

const ACTION_VERBS = new Set([
  'achieved','managed','led','built','created','improved','reduced','increased',
  'developed','designed','delivered','implemented','launched','streamlined',
  'coordinated','negotiated','trained','mentored','analyzed','generated',
  'drove','exceeded','established','spearheaded','executed','maintained',
  'resolved','collaborated','facilitated','administered','optimized',
  'transformed','secured','expanded','accelerated','automated','directed',
  'oversaw','produced','shaped','grew','owned','shipped','deployed','migrated'
])

function scoreFormat(resumeText) {
  if (!resumeText || resumeText.trim().length < 100)
    return { score: 0, detail: { issues: ['Resume could not be parsed'] } }
  let score = 100; const issues = []
  if ((resumeText.match(/\|/g) || []).length > 5)
    { score -= 15; issues.push('Tables detected — ATS may fail to parse') }
  const bTypes = new Set((resumeText.match(/^[\s]*[•\-\*◦]/mg) || []).map(b => b.trim()[0]))
  if (bTypes.size > 2)
    { score -= 15; issues.push('Inconsistent bullet style') }
  if (resumeText.split('\n').filter(l => l.length > 200).length > 3)
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
  const optional = [
    { name: 'Summary',        patterns: ['summary','objective','profile'] },
    { name: 'Certifications', patterns: ['certification','licenses','awards'] },
  ]
  const lines10  = lower.split('\n').slice(0, 10).join(' ')
  const hasEmail = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/.test(lines10)
  const foundReq = required.filter(s => s.patterns ? s.patterns.some(p => lower.includes(p)) : hasEmail)
  const foundOpt = optional.filter(s => s.patterns.some(p => lower.includes(p)))
  return {
    score: Math.min(100, Math.round((foundReq.length / 4) * 70 + (foundOpt.length / 2) * 30)),
    detail: {
      found:   foundReq.map(s => s.name),
      missing: required.filter(s => !foundReq.includes(s)).map(s => s.name)
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
  const BULLET_LINE = /^\s*(?:[•\-\*◦▪‣·]|[0-9A-Za-z]+[.)])\s/
  const bullets = resumeText.split('\n').filter(l => BULLET_LINE.test(l))
  const total   = bullets.length || 1
  const actionCount = bullets.filter(b => {
    const words = b.trim().replace(BULLET_LINE, '').trim().toLowerCase().split(/\s+/)
    return words.length > 0 && ACTION_VERBS.has(words[0])
  }).length
  let score = Math.round((actionCount / total) * 100)
  const quantifiedCount = (resumeText.match(/\d+\s*(%|\$|k\b|m\b|million|thousand)/gi) || []).length
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
