// Which skill renames are legitimate. The rewrite prompt may rename a skill to the posting's exact term only when the two
// names are the SAME thing and differ in spelling, spacing or abbreviation - never a version, never a related tool. The
// model reports every rename in `skillRenames`; this decides, in code, whether each one is allowed.

const GROUPS = [
  ['postgres', 'postgresql', 'postgre sql', 'psql'],
  ['js', 'javascript', 'java script'],
  ['ts', 'typescript', 'type script'],
  ['node', 'nodejs', 'node js'],
  ['react', 'reactjs', 'react js'],
  ['vue', 'vuejs', 'vue js'],
  ['nextjs', 'next js'],
  ['mongo', 'mongodb', 'mongo db'],
  ['k8s', 'kubernetes'],
  ['gcp', 'google cloud', 'google cloud platform'],
  ['aws', 'amazon web services'],
  ['ms excel', 'microsoft excel', 'excel'],
  ['ms word', 'microsoft word', 'word'],
  ['ms office', 'microsoft office'],
  ['powerpoint', 'ms powerpoint', 'microsoft powerpoint'],
  ['seo', 'search engine optimization', 'search engine optimisation'],
  ['sem', 'search engine marketing'],
  ['crm', 'customer relationship management'],
  ['ci cd', 'cicd', 'continuous integration continuous delivery'],
  ['ml', 'machine learning'],
  ['nlp', 'natural language processing'],
  ['ux', 'user experience'],
  ['ui', 'user interface'],
  ['qa', 'quality assurance'],
  ['hr', 'human resources'],
  ['rest', 'rest api', 'rest apis', 'restful api', 'restful apis'],
  ['gsuite', 'g suite', 'google workspace'],
  ['sql server', 'ms sql server', 'microsoft sql server', 'mssql'],
  ['dotnet', 'dot net'],
]

const squash = s => String(s == null ? '' : s).toLowerCase().replace(/c\+\+/g, 'cpp').replace(/c#/g, 'csharp').replace(/\.net\b/g, 'dotnet')
  .replace(/[^\p{L}\p{N}\s]+/gu, '').replace(/\s+/g, ' ').trim()
const noSpace = s => squash(s).replace(/\s+/g, '')
const versionsOf = s => (String(s || '').match(/\d+(?:\.\d+)*/g) || [])

const GROUP_OF = new Map()
GROUPS.forEach((g, i) => g.forEach(name => { GROUP_OF.set(squash(name), i); GROUP_OF.set(noSpace(name), i) }))

// `resumeText` is everything the person wrote (a version may be used only when they stated it).
function isAllowedRename(from, to, resumeText) {
  const a = squash(from), b = squash(to)
  if (!a || !b) return false
  // Known synonyms (including names that merely contain a digit, like K8s) are decided by the table alone.
  const wholeA = GROUP_OF.get(a) ?? GROUP_OF.get(noSpace(from)), wholeB = GROUP_OF.get(b) ?? GROUP_OF.get(noSpace(to))
  if (wholeA !== undefined && wholeA === wholeB) return true
  // A version is part of the name: the two sides must carry the same version numbers, or the resume must state the new one.
  const va = versionsOf(from).join('|'), vb = versionsOf(to).join('|')
  if (va !== vb) {
    const hay = String(resumeText || '')
    if (!versionsOf(to).every(v => new RegExp(`(?:^|[^\\d.])${v.replace(/\./g, '\\.')}(?![\\d])`).test(hay))) return false
    if (!vb) return false
  }
  const na = noSpace(from.replace(/[\d.]+/g, '')), nb = noSpace(to.replace(/[\d.]+/g, ''))
  if (na && na === nb) return true                                // "Node js" -> "Node.js", "MS  Excel" -> "MS Excel"
  const ga = GROUP_OF.get(squash(from.replace(/[\d.]+/g, ''))) ?? GROUP_OF.get(na)
  const gb = GROUP_OF.get(squash(to.replace(/[\d.]+/g, ''))) ?? GROUP_OF.get(nb)
  return ga !== undefined && ga === gb
}


// ── Acronym + expansion pairs ───────────────────────────────────────────────────────────────────────────────────────
// An employer's ATS search matches the string a recruiter types - "SEO" or "Search Engine Optimization" - and a resume that carries
// only one form is invisible to the other search. When the person's skills list holds one form of a pair below and the posting uses
// either form, the skill is written as "Search Engine Optimization (SEO)". Nothing is added: both spellings name the same skill the
// person already listed. A pair is written out only for terms with one unambiguous expansion (no "PM", "CMS", "AI").
const ACRONYM_PAIRS = [
  ['SEO', 'Search Engine Optimization'], ['SEM', 'Search Engine Marketing'], ['CRM', 'Customer Relationship Management'],
  ['ML', 'Machine Learning'], ['NLP', 'Natural Language Processing'], ['UX', 'User Experience'], ['UI', 'User Interface'],
  ['QA', 'Quality Assurance'], ['HR', 'Human Resources'], ['AWS', 'Amazon Web Services'], ['GCP', 'Google Cloud Platform'],
  ['K8s', 'Kubernetes'], ['ERP', 'Enterprise Resource Planning'], ['KPI', 'Key Performance Indicators'],
  ['ETL', 'Extract, Transform, Load'], ['OKR', 'Objectives and Key Results'], ['SaaS', 'Software as a Service'],
]
const pairKey = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const wholeWord = (hay, term) => new RegExp(`(?<![\\p{L}\\p{N}])${String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu').test(hay)

// skills: the person's skills list; jdText: the posting. Returns a new list (same order, one entry per pair, no duplicates).
function pairAcronyms(skills, jdText) {
  if (!Array.isArray(skills)) return skills
  const jd = String(jdText || '')
  const out = []
  const done = new Set()
  for (const sk of skills) {
    if (typeof sk !== 'string') { out.push(sk); continue }
    const k = pairKey(sk)
    const pair = ACRONYM_PAIRS.find(([a, b]) => pairKey(a) === k || pairKey(b) === k)
    if (!pair) { out.push(sk); continue }
    const [short, long] = pair
    if (done.has(short)) continue                                   // the other form was already merged into the first
    // The posting must use one of the two forms; a skill the posting never mentions is left exactly as written.
    if (!wholeWord(jd, short) && !wholeWord(jd, long)) { out.push(sk); continue }
    done.add(short)
    out.push(`${long} (${short})`)
  }
  // An entry that already reads "Long (SHORT)" in the input is kept as is by the loop above (its key matches neither form).
  return out
}

module.exports = { pairAcronyms, ACRONYM_PAIRS, isAllowedRename, squash, noSpace, versionsOf }
