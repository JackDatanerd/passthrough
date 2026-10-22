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
// Round 15: the stem above (5 letters from 7) is right for "manage/managed/management" and wrong for tool names: "excellent",
// "excelled" and "excellence" all became "excel", so an invented Excel passed the guard (and "excellent" was flagged as an
// invented tool); the same for Spark/"sparked" and Express/"expressed". Tool names are therefore matched on the word itself
// (plural folded only), kept in the set under an "=" prefix next to the stems.
const pluralFold = w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
// "Node.js" is one tool name; wordsOf splits it at the dot into "node" + "js", but a name read out of a rewritten line comes
// back joined ("nodejs"). Joined forms of dotted names are therefore in the set too. Before this a resume that said "Node.js"
// (or Next.js, Vue.js) failed the guard on every rewrite that kept the name.
const DOTTED_NAME = /[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)+/gu
function haveSet(text) {
  const words = wordsOf(text)
  const have = new Set(words.map(foldWord))
  for (const w of words) have.add('=' + pluralFold(w))
  for (const m of String(text || '').toLowerCase().matchAll(DOTTED_NAME)) {
    const joined = m[0].replace(/\./g, '')
    have.add(foldWord(joined)); have.add('=' + pluralFold(joined))
  }
  for (const g of SKILL_ALIASES) {
    const stems = g.map(foldWord), exact = g.map(x => '=' + pluralFold(x))
    if (stems.some(x => have.has(x))) stems.forEach(x => have.add(x))
    if (exact.some(x => have.has(x))) exact.forEach(x => have.add(x))
  }
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
const TECH_EXACT = new Set(TECH_TERMS.map(pluralFold))
const isTechTerm = w => TECH_EXACT.has(pluralFold(String(w || '').toLowerCase()))
// Is `w` something the text already says? A tool name must be there as itself ("Node.js" where the resume says "Node" is the
// same tool); any other word is compared on its stem.
function knownWord(have, w) {
  const l = String(w || '').toLowerCase()
  const pf = pluralFold(l)
  if (TECH_EXACT.has(pf)) return have.has('=' + pf) || (l.length > 4 && l.endsWith('js') && have.has('=' + pluralFold(l.slice(0, -2))))
  return have.has(foldWord(l))
}

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
        const isTech = TECH_EXACT.has(pluralFold(lower))
        const isNameLike = idx > 0 && /^\p{Lu}/u.test(w)
        if (!isTech && !isNameLike) continue
        if (NAME_OK.has(lower) || knownWord(have, lower)) continue
        const parts = lower.split(/['’]/).filter(x => x.length >= 2)
        if (/['’]/.test(lower) && parts.length && parts.every(x => NAME_OK.has(x) || knownWord(have, x))) continue
        found.add(w)
      }
    })
  }
  return [...found]
}


// ── scope and context ("high-volume", "across multiple regions", "as team lead", "senior stakeholders") ──────────────────────────────
// The commonest way a polished line stops being true is not a tool or a number but a SETTING the person never described: the work
// becomes high-volume, cross-functional, enterprise-wide, done for senior leadership, or done as the team lead. The prompt forbids
// it (example (b): do NOT add "high-volume"), and nothing checked it. A phrase below is judged by its words: it is fine only when
// every content word of it is one the person's own text for that role already says (so "stakeholders" they wrote allows "key
// stakeholders", but never "senior stakeholders"). Deliberately a list of PHRASES, never single generic words.
const SCOPE_PHRASES = new RegExp(`\\b(?:` + [
  `high[- ]volume`, `high[- ]stakes`, `high[- ]pressure`, `large[- ]scale`, `mission[- ]critical`, `business[- ]critical`,
  `(?:enterprise|company|organi[sz]ation|nation|country|region|worldwide|firm)[- ]wide`, `enterprise[- ](?:level|grade)`,
  `global(?:ly)?`, `worldwide`, `international(?:ly)?`, `multi[- ]?(?:regional|national|site|country|market|million|billion)`,
  `across\\s+(?:multiple|several|many|various|numerous|\\d+|all|the)\\s+(?:regions?|countries|markets|sites|offices|locations|business units|departments|teams|functions|products|branches|clients)`,
  `(?:multiple|several|many)\\s+(?:regions|countries|markets|sites|offices|locations|business units|departments|branches)`,
  `(?:senior|executive)\\s+(?:leadership|management|stakeholders?|executives?|leaders?|staff|team)`, `c[- ]?suite`, `c[- ]?level`, `board(?:\\s+of\\s+directors)?`,
  `cross[- ]functional(?:ly)?`, `fast[- ]paced`, `(?:highly\\s+)?regulated`, `complex`, `world[- ]class`, `best[- ]in[- ]class`, `cutting[- ]edge`, `state[- ]of[- ]the[- ]art`,
  `ensur(?:e|ed|es|ing)\\s+(?:compliance|accuracy|quality|consistency|alignment|data integrity)`, `compliance`,
  `driv(?:e|es|ing)\\s+(?:\\w+\\s+){0,2}(?:growth|satisfaction|engagement|adoption|efficiency|revenue|retention|results|performance)`, `drove\\s+(?:\\w+\\s+){0,2}(?:growth|satisfaction|engagement|adoption|efficiency|revenue|retention|results|performance)`,
  `(?:team|tech|technical|project|squad|shift|section|desk|floor|product)\\s+(?:lead|leader|captain)`,
  `(?:as|became|promoted\\s+to|served\\s+as)\\s+(?:the\\s+|a\\s+|an\\s+)?(?:lead|head|manager|supervisor)`,
  `mentor(?:ed|ing|s)?`, `coach(?:ed|ing)?`,
].join('|') + `)\\b`, 'gi')
// Words that carry no claim of their own inside a matched phrase.
const SCOPE_STOP = new Set(['across', 'multiple', 'several', 'many', 'various', 'numerous', 'all', 'the', 'a', 'an', 'of', 'as', 'to', 'key', 'ensuring', 'ensure', 'ensured', 'ensures', 'driving', 'drive', 'drives', 'drove', 'became', 'served', 'promoted', 'highly'])
// The shared foldWord stem (5 letters from 7) makes "complex" and "compliance" the same word; a scope word is compared on its first six letters.
const scopeStem = w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w).slice(0, 6)
function scopeProblems(text, jobSource) {
  const have = new Set(wordsOf(jobSource).map(scopeStem))
  const out = []
  for (const m of String(text || '').matchAll(SCOPE_PHRASES)) {
    const words = wordsOf(m[0]).filter(w => !SCOPE_STOP.has(w))
    if (!words.length) continue
    // "regulated" / "regulations", "mentor" / "mentored": the stem decides, as everywhere else.
    if (words.every(w => have.has(scopeStem(w)))) continue
    const phrase = m[0].toLowerCase()
    if (!out.includes(phrase)) out.push(phrase)
  }
  return out
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
  for (const r of listOf(renames)) if (r && typeof r.to === 'string') wordsOf(r.to).forEach(w => { have.add(foldWord(w)); have.add('=' + pluralFold(w)) })

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
    for (const sc of scopeProblems(t, js.text)) problems.push(`${where}: adds \"${sc}\", a setting, scale or role the resume never describes - keep the scope the person gave (\"${clip(t)}\")`)
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
  SKILL_ALIASES, foldWord, pluralFold, wordsOf, haveSet, isTechTerm, knownWord,
  OWNERSHIP, RANK_TITLE, hasOwnership, ownershipHits, ownershipProblem, letterOwnershipProblem,
  outcomeProblems, scopeProblems, unknownTerms, rankProblems, findClaimProblems,
  withoutHorizons, confessions, TECH_TERMS,
}
