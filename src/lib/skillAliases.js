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

module.exports = { isAllowedRename, squash, noSpace, versionsOf }
