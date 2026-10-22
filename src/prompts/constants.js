// One definition of every number and list that a prompt states AND a guard or an eval enforces. Before this file the
// letter length was 220-300 in the prompt, 320 in the guard and 180-320 in the eval, and the banned phrases lived in
// three places. Prompts interpolate these, guards import them, evals import them: they cannot drift apart.

const LETTER_WORDS = { min: 220, max: 300, ceiling: 320 }
const BULLET_WORDS = { prompt: 25, guard: 28 }       // the guard has slack for hyphenations and figures counted as words
const SUMMARY_WORDS = { min: 40, max: 60, guardMin: 25, guardMax: 75 }
const VERB_CAP_PER_ROLE = 1                          // a verb may open one bullet per role...
const VERB_CAP_WHOLE_RESUME = 3                      // ...and at most this many bullets across the whole resume

// Buzzwords and openers. The PROMPT shows the short list (a long list only primes the model toward the words); the
// GUARD checks the long one, near-synonyms included.
const BUZZ_WORDS = [
  'team player', 'hard-working', 'hardworking', 'hard working', 'self-starter', 'self starter', 'go-getter', 'proven track record',
  'synergy', 'synergies', 'leverage', 'leveraged', 'leverages', 'leveraging', 'utilize', 'utilise', 'utilized', 'utilised',
  'utilizes', 'utilises', 'utilizing', 'utilising', 'various', 'etc', 'results-driven', 'results driven', 'detail-oriented',
  'detail oriented', 'dynamic', 'passionate', 'driven professional', 'highly motivated', 'seasoned', 'rockstar', 'ninja',
  'guru', 'think outside the box', 'fast learner', 'hard worker',
]
const BAD_OPENER_PHRASES = ['responsible for', 'responsibilities included', 'responsibilities include', 'helped', 'assisted with', 'worked on', 'tasked with', 'duties included', 'duties include', 'duties were', 'in charge of']

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// "dynamic" is a buzzword only as a self-description ("a dynamic professional"); "dynamic programming", "dynamic pricing" and the
// like are technical terms and correct resume wording (Scan/ATS round 12). Every place that checks the buzzword list goes
// through here, so the exception applies to the rewrite guard and the letter guard alike.
const DYNAMIC_TECHNICAL = 'pricing|programming|content|range|routing|typing|allocation|analysis|web|dns|memory|data|dashboards?|forms?|pages?|reports?|schema|systems?|scaling|sql|languages?|libraries|linking|simulation|modeling|modelling|ads?|creative|signage|rendering|provisioning|queries|query|tables?|views?|workflows?'
// "leverage" is a buzzword as a verb for "use" ("leveraged my skills"), and a core term of art in finance ("leveraged buyout",
// "leveraged finance", "leverage ratio", "financial leverage"): a banned-word rule must not strip the keyword a finance posting
// asks for. The family is exempt only when a finance noun follows it or a finance adjective precedes it.
const LEVERAGE_TERM_AFTER = 'buyouts?|finance|financing|loans?|lending|ratios?|facilit(?:y|ies)|recapitali[sz]ations?|positions?|funds?|etfs?|credit|debt|transactions?|deals?|structures?|returns?|multiples?|covenants?|lbos?'
const LEVERAGE_TERM_BEFORE = 'financial|operating|debt|net|high|low|negative|positive'
const isLeverage = w => /^leverag(?:e|ed|es|ing)$/.test(w)
const buzzAlternation = list => list.map(w => {
  if (w === 'dynamic') return `dynamic(?!\\s+(?:${DYNAMIC_TECHNICAL}))`
  if (isLeverage(w)) return `(?<!\\b(?:${LEVERAGE_TERM_BEFORE})\\s)${esc(w)}(?!\\s+(?:${LEVERAGE_TERM_AFTER})\\b)`
  return esc(w)
}).join('|')
const wordsRegex = (list, flags = 'i') => new RegExp(`\\b(?:${buzzAlternation(list)})\\b`, flags)

// Per-prompt versions, so a change in one prompt can be told apart from a change in another in the interview-outcome
// numbers (scans.prompt_version / scans.letter_prompt_version, migration 0094). Bump the one you changed.
const PROMPT_VERSIONS = { score: 4, rewrite: 7, extract: 4, letter: 6 }
const FIX_PROMPT_VERSION = `docgen-rewrite${PROMPT_VERSIONS.rewrite}.score${PROMPT_VERSIONS.score}.extract${PROMPT_VERSIONS.extract}`
const LETTER_PROMPT_VERSION = `docgen-letter${PROMPT_VERSIONS.letter}`

module.exports = {
  LETTER_WORDS, BULLET_WORDS, SUMMARY_WORDS, VERB_CAP_PER_ROLE, VERB_CAP_WHOLE_RESUME,
  BUZZ_WORDS, BAD_OPENER_PHRASES, wordsRegex, buzzAlternation, esc,
  PROMPT_VERSIONS, FIX_PROMPT_VERSION, LETTER_PROMPT_VERSION,
}
