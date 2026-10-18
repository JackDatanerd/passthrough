// Claims a document may not make unless the person's own resume makes them. The rewrite and letter prompts state these
// rules ("keep their level", "never add a tool", "no result the input does not state"), but until this file nothing in
// code enforced them (reproduced: "Helped" -> "Led", "Assisted" -> "Owned", a Tableau dashboard in a bullet, "improved
// customer satisfaction" out of nowhere, "Senior Data Engineer ... leading data teams" in a summary, and "a team of eleven
// analysts" in a letter all passed every guard). Each of those can reach an interview, and a fabricated tool in a bullet is
// credited by the scorer, so it can also lift a score over the credential line.
//
// Pure functions, no I/O. `source` is the person's own text as one string (claude.service sourceText). A line the person
// already wrote verbatim is theirs and is never judged by the callers (same rule as lib/rewriteStyle.js).

const SKILL_ALIASES = [
  ['js', 'javascript'], ['ts', 'typescript'], ['k8s', 'kubernetes'], ['postgres', 'postgresql'],
  ['golang', 'go'], ['ml', 'machine'], ['ai', 'artificial'], ['aws', 'amazon'], ['gcp', 'google'],
  ['cicd', 'ci', 'cd'], ['ux', 'user'], ['qa', 'quality'], ['bi', 'business'], ['seo', 'search'],
  ['crm', 'customer'], ['erp', 'enterprise'], ['sql', 'database'], ['nosql', 'database'],
]
const foldWord = w => {
  const f = w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w
  // crude stem so manage/managed/management and engineer/engineering agree
  return f.length >= 7 ? f.slice(0, 5) : f
}
const wordsOf = t => String(t || '').toLowerCase()
  .replace(/c\+\+/g, 'cplusplus').replace(/c#/g, 'csharp').replace(/\.net\b/g, 'dotnet')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean)

// The set of folded words a text contains, with the interchangeable tool names added.
function haveSet(text) {
  const have = new Set(wordsOf(text).map(foldWord))
  for (const group of SKILL_ALIASES.map(g => g.map(foldWord))) if (group.some(g => have.has(g))) group.forEach(g => have.add(g))
  return have
}

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const nk = v => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const listOf = v => (Array.isArray(v) ? v : [])
const textOf = v => (typeof v === 'string' ? v : '')
const clip = t => (t.length > 70 ? t.slice(0, 67) + '...' : t)

// ── ownership ("led", "owned", "managed a team") ───────────────────────────────────────────────────────────────────
// Past-tense and unambiguous forms only: "lead" / "leads" are ordinary nouns ("lead generation", "team lead") and "ran" /
// "managed reports" are routine wording that a rewrite may use without claiming rank.
const PEOPLE = 'team|teams|staff|people|analysts?|engineers?|developers?|agents?|interns?|employees|direct reports|members|department|budget|portfolio|program|programme|p&l|headcount'
const OWNERSHIP = new RegExp(
  `\\b(?:led|spearheaded|directed|headed|owned|oversaw|supervised|founded|co-?founded|chaired|architected|championed|leading\\s+(?:a|an|the|my|our|\\d+|teams?|cross)|managed\\s+(?:\\w+\\s+){0,2}?(?:${PEOPLE}))\\b`, 'gi')
// A title that carries the rank itself: a "Team Lead" may say "led".
const RANK_TITLE = /\b(?:manager|lead|head|director|chief|founder|co-?founder|owner|principal|supervisor|vp|vice president|president|senior|sr|executive|captain|chair|partner|consultant)\b/i

const hasOwnership = text => { OWNERSHIP.lastIndex = 0; return OWNERSHIP.test(String(text || '')) }
const ownershipHits = text => { OWNERSHIP.lastIndex = 0; return [...String(text || '').matchAll(OWNERSHIP)].map(m => m[0].toLowerCase()) }

// `jobSource` = what the person wrote about THIS role (title + bullets); `title` = the role's title.
function ownershipProblem(text, jobSource, title) {
  const hits = ownershipHits(text)
  if (!hits.length) return null
  if (hasOwnership(jobSource) || RANK_TITLE.test(String(title || ''))) return null
  return hits[0]
}

// ── outcomes ("reduced", "improved", "saved") ───────────────────────────────────────────────────────────────────────
// A result is a claim about the world. A rewrite may restate the result the input gives (\"cut agency spend\" -> \"Reduced
// agency spend\") but may not add one. Families, so the honest swap cut <-> reduced is not an invention.
const OUTCOME_FAMILIES = [
  { name: 'a reduction', words: /\b(?:reduc\w*|cut|cuts|cutting|decreas\w*|lower(?:ed|ing|s)?|trim(?:med|ming)?|shrank|shrunk|slash(?:ed|ing)?|fell|minimi[sz]\w*|declin\w*|fewer|less)\b/i, initialToo: true },
  { name: 'a saving', words: /\b(?:sav(?:e|ed|es|ing|ings)|economi[sz]\w*)\b/i, initialToo: true },
  { name: 'an elimination', words: /\b(?:eliminat\w*|eradicat\w*)\b/i, initialToo: true },
  { name: 'an increase', words: /\b(?:increas\w*|grew|grow(?:n|ing|th)?|boost\w*|lift(?:ed|ing)?|doubl\w*|tripl\w*|expand\w*|accelerat\w*)\b/i, initialToo: false },
  { name: 'an improvement', words: /\b(?:improv\w*|enhanc\w*|strengthen\w*|optimi[sz]\w*|streamlin\w*)\b/i, initialToo: false },
]
// The wording "resulting in X" / "leading to X" / "which improved X" always asserts a result.
const RESULT_CLAUSE = /\b(?:resulting in|leading to|which (?:led|resulted)|thereby)\b/i

function outcomeProblems(text, jobSource) {
  const out = []
  const t = String(text || '')
  const firstWord = (t.trim().match(/^[\p{L}]+/u) || [''])[0]
  for (const fam of OUTCOME_FAMILIES) {
    const gl = new RegExp(fam.words.source, 'gi')
    const found = [...t.matchAll(gl)].filter(m => fam.initialToo || m.index > firstWord.length)
    if (!found.length) continue
    if (fam.words.test(jobSource)) continue                  // the input already states this kind of result for the role
    out.push(`${fam.name} (\"${found[0][0]}\")`)
  }
  const rc = t.match(RESULT_CLAUSE)
  if (rc && !RESULT_CLAUSE.test(jobSource) && !out.length) out.push(`a result (\"${rc[0]}\")`)
  return out
}

// ── tools, methods and names ────────────────────────────────────────────────────────────────────────────────────────
// Lowercase technology names a capital-letter check cannot see. Deliberately a list of NAMES, never generic words.
const TECH_TERMS = `dbt pandas numpy scipy sklearn pytorch tensorflow keras spark pyspark hadoop hive kafka airflow luigi dagster
  docker kubernetes helm terraform ansible puppet chef jenkins circleci travis git github gitlab bitbucket jira confluence asana trello notion slack
  tableau looker powerbi qlik metabase redash snowflake bigquery redshift databricks postgres postgresql mysql mariadb mongodb redis cassandra dynamodb elasticsearch oracle
  react vue angular svelte nextjs nodejs express django flask fastapi rails laravel spring dotnet graphql
  python java javascript typescript golang rust ruby php scala kotlin swift matlab sas stata excel
  aws azure gcp salesforce hubspot marketo zendesk intercom sap netsuite quickbooks workday
  figma sketch photoshop illustrator indesign scrum agile kanban lean sixsigma six-sigma prince2 pmp`.split(/\s+/).filter(Boolean)
const TECH_FOLDED = new Set(TECH_TERMS.map(foldWord))

const NAME_OK = new Set(`i dear sincerely hiring manager team thank thanks best regards kind yours mr mrs ms mx dr prof
  january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday
  english american british african european asian us uk usa eu un cv ceo cto cfo coo vp hr it ai kpi kpis roi okr okrs b2b b2c saas q1 q2 q3 q4 ok
  fy ytd mom yoy sla slas qa pto ngo ngos`.split(/\s+/))

// Names and technologies in `text` that the person's own text never mentions. `have` = haveSet(source) plus anything the
// caller allows (a declared skill rename). Sentence-initial words are skipped (every bullet starts with a capital).
function unknownTerms(text, have) {
  const found = new Set()
  const line = String(text || '')
  for (const seg of line.split(/(?<=[.!?:;])\s+/)) {
    seg.trim().split(/\s+/).forEach((tok, idx) => {
      for (const piece of tok.split(/[-–—/]/)) {
        const w = piece.replace(/['’]s$/i, '').replace(/[^\p{L}\p{N}'’]+/gu, '')
        if (w.length < 2) continue
        const lower = w.toLowerCase()
        const isTech = TECH_FOLDED.has(foldWord(lower))
        const isNameLike = idx > 0 && /^\p{Lu}/u.test(w)
        if (!isTech && !isNameLike) continue
        if (NAME_OK.has(lower) || have.has(foldWord(lower))) continue
        const parts = lower.split(/['’]/).filter(x => x.length >= 2)
        if (/['’]/.test(lower) && parts.length && parts.every(x => NAME_OK.has(x) || have.has(foldWord(x)))) continue
        found.add(w)
      }
    })
  }
  return [...found]
}

// ── seniority words in a summary ───────────────────────────────────────────────────────────────────────────────────
const RANK_WORDS = /\b(?:senior|principal|head of|director|chief|executive|vp|vice president|expert|veteran|leader|leadership|(?:team|tech|technical|project|engineering)\s+lead)\b/gi
function rankProblems(text, have) {
  const out = []
  for (const m of String(text || '').matchAll(RANK_WORDS)) {
    const ws = wordsOf(m[0]).map(foldWord)
    if (!ws.every(w => have.has(w)) && !out.includes(m[0].toLowerCase())) out.push(m[0].toLowerCase())
  }
  return out
}

// ── the resume rewrite ──────────────────────────────────────────────────────────────────────────────────────────────
// Judges only text the model WROTE (a line already in the person's resume verbatim is theirs). `renames` are the skill
// renames the model declared (they have been validated separately), whose new names are allowed to appear.
function findClaimProblems(original, rewritten, { source = '', renames = [] } = {}) {
  const problems = []
  const mine = new Set()
  const addMine = t => { const n = norm(t); if (n) mine.add(n) }
  addMine(original?.summary)
  for (const e of listOf(original?.experience)) listOf(e?.bullets).forEach(addMine)
  for (const v of listOf(original?.volunteer)) listOf(v?.bullets).forEach(addMine)
  for (const p of listOf(original?.projects)) addMine(p?.description)
  const fresh = t => { const n = norm(t); return n && !mine.has(n) }

  const have = haveSet(source)
  for (const r of listOf(renames)) if (r && typeof r.to === 'string') wordsOf(r.to).forEach(w => have.add(foldWord(w)))

  const jobSourceFor = job => {
    const key = nk(job?.company)
    const match = key ? listOf(original?.experience).find(o => nk(o?.company) === key) : null
    if (!match) return { text: source, title: job?.title }
    return { text: [match.title, ...listOf(match.bullets)].map(textOf).join('\n'), title: match.title || job?.title }
  }

  const checkLine = (t, where, js, { summary = false } = {}) => {
    if (!fresh(t)) return
    const own = ownershipProblem(t, js.text, js.title)
    if (own) problems.push(`${where}: \"${own}\" claims leadership or ownership the resume does not state - keep the person's own level (\"${clip(t)}\")`)
    for (const o of outcomeProblems(t, js.text)) problems.push(`${where}: states ${o} that the resume does not - keep the result the input gives, or none (\"${clip(t)}\")`)
    const names = unknownTerms(t, have)
    if (names.length) problems.push(`${where}: names ${names.slice(0, 4).join(', ')}, which the resume never mentions - never add a tool, method or name (\"${clip(t)}\")`)
    if (summary) {
      const ranks = rankProblems(t, have)
      if (ranks.length) problems.push(`the summary uses \"${ranks[0]}\", which no title or line of the resume supports`)
    }
  }

  const summary = textOf(rewritten?.summary)
  if (summary) checkLine(summary, 'the summary', { text: source, title: listOf(original?.experience).map(e => textOf(e?.title)).join(' ') }, { summary: true })
  listOf(rewritten?.experience).forEach((e, i) => {
    const js = jobSourceFor(e)
    listOf(e?.bullets).forEach(b => checkLine(textOf(b), `job ${i + 1}${e?.company ? ` (${textOf(e.company)})` : ''}`, js))
  })
  listOf(rewritten?.volunteer).forEach((v, i) => {
    listOf(v?.bullets).forEach(b => checkLine(textOf(b), `volunteer ${i + 1}`, { text: source, title: v?.role }))
  })
  listOf(rewritten?.projects).forEach((p, i) => checkLine(textOf(p?.description), `project ${i + 1}`, { text: source, title: '' }))
  return problems
}

// ── the cover letter ────────────────────────────────────────────────────────────────────────────────────────────────
// Time horizons in a plan (\"in the first 90 days\", \"over the next two weeks\") promise the future; they claim nothing
// about the past, so their numbers are not a claim about the applicant.
const HORIZON = /\b(?:first|next|within|in|over|by|after)\s+(?:the\s+)?(?:first\s+|next\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|thirty|sixty|ninety)(?:\s*-\s*|\s+)(?:days?|weeks?|months?)\b/gi
const withoutHorizons = t => String(t || '').replace(HORIZON, ' ')

// Statements of what the candidate LACKS. Only legitimate when the scorer found a genuine must-have gap.
const CONFESSION = /\b(?:i (?:do not|don't|have not|haven't|did not|didn't|am yet to|lack)\s+(?:yet\s+)?(?:have|hold|held|work(?:ed)?|use[d]?|done|do|manage[d]?|led|lead|own(?:ed)?|had|the)\b|i am (?:new to|still learning|not yet)\b|i have no (?:formal |direct |professional )?(?:experience|background|training|qualification)s?\b|i (?:am )?(?:not|never) (?:been )?(?:a |an )?(?:certified|qualified|accredited|licen[cs]ed)\b|without (?:formal|direct|professional) (?:experience|training)\b)/gi
function confessions(text) { return [...String(text || '').matchAll(CONFESSION)].map(m => m[0]) }

// `titles` = every job title in the resume as one string: a person who held a rank title may say they led.
function letterOwnershipProblem(text, source, titles = '') {
  const hits = ownershipHits(text)
  if (!hits.length) return null
  if (hasOwnership(source) || RANK_TITLE.test(String(titles || ''))) return null
  return hits[0]
}

module.exports = {
  SKILL_ALIASES, foldWord, wordsOf, haveSet,
  OWNERSHIP, RANK_TITLE, hasOwnership, ownershipHits, ownershipProblem, letterOwnershipProblem,
  outcomeProblems, unknownTerms, rankProblems, findClaimProblems,
  withoutHorizons, confessions, TECH_TERMS,
}
