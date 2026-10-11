// EVERYTHING on the homepage that is copy or sample data lives here, so the final pass is one file.
//
// Three kinds of thing are in this file — know which is which before you edit:
//
//   1. STATS_FALLBACK — the numbers the page shows until the live ones qualify. The live source is
//      GET /api/stats (resumes scanned, and the interview rate once MIN responses are in). Until then
//      these are what visitors see, so they must be TRUE or removed. Set a value to null to hide that
//      stat's claim instead of showing a number.
//
//   2. SAMPLE_STORIES / SAMPLE_HOT — design placeholders. They are shown ONLY while the database has no
//      approved stories / no field with enough reports, and while shown the page tags them "Sample" so
//      they can never pass as real. Replace them with real, consented ones, or empty the arrays to
//      hide the sections until real data arrives.
//
//   3. BEFORE_AFTER — an illustration, labelled "Illustrative example" on the page. Keep the four
//      category names: they are the product's real score categories (CategoryScores.jsx).
//
// Nothing here is read by the backend; the backend's own numbers always win over this file.

// Set the interview rate to null to hide the claim until you have the data behind it.
export const STATS_FALLBACK = { resumesScanned: 25000, interviewRatePct: 66 }

// Below this many live scans the live count is not used (a small true number reads as a weak claim and
// the fallback above is the operator's own figure). Above it, the live count always wins.
export const MIN_LIVE_SCANS = 1000

export const ATS_NAMES = ['Workday', 'Greenhouse', 'iCIMS', 'Taleo', 'Lever', 'SuccessFactors']

export const BEFORE_AFTER = {
  before: {
    score: 52,
    verdict: 'Failing ATS filters',
    sub: 'Rejected before a recruiter opens it',
    rows: [['Keyword Match', 42], ['Formatting', 58], ['Sections', 71], ['Content', 39]],
    keywords: ['stakeholder management', 'roadmap', 'A/B testing', 'SQL'],
  },
  after: {
    score: 91,
    verdict: 'Passes ATS filters',
    sub: 'Eligible for the Passthrough Verified credential',
    rows: [['Keyword Match', 92], ['Formatting', 94], ['Sections', 90], ['Content', 88]],
    keywords: ['stakeholder management', 'roadmap', 'A/B testing', 'SQL'],
  },
}

// Shape matches GET /api/stats `stories[]` exactly, so real and sample render through the same code.
export const SAMPLE_STORIES = [
  {
    id: 'sample-1', displayName: 'Amara O.', roleCategory: 'software_engineering', scoreBefore: 48, scoreAfter: 88,
    interviewCount: null, interviewAfterDays: 6, credentialCode: null,
    quote: 'Forty applications, zero replies. After the fix, I heard back from the first role I sent it to.',
    story: "I'd been applying for two months and assumed the market was just brutal. My resume was a beautiful two-column template from a free design tool. The scan showed the robot read it as one jumbled block: my email was invisible and half my skills never got parsed.\n\nI rebuilt it in a clean single column, let Passthrough tighten the weak bullets, and got to 88 with a Verified link. I put the link in my application email. The recruiter told me later it's why she opened my file first.",
    moral: 'The robot reads text, not taste.',
  },
  {
    id: 'sample-2', displayName: 'Daniel M.', roleCategory: 'healthcare', scoreBefore: 55, scoreAfter: 91,
    interviewCount: 3, interviewAfterDays: 14, credentialCode: null,
    quote: 'I changed careers. Passthrough translated my experience into the language the job posts use.',
    story: 'Ten years in logistics, applying to hospital operations. My resume was true, but none of the words matched. The keyword gap list read like a translation guide.\n\nAfter the rewrite I put the verification badge in my email signature. Two of my three interviews brought it up before I did.',
    moral: "Claims are cheap. Receipts aren't.",
  },
  {
    id: 'sample-3', displayName: 'Dana R.', roleCategory: 'operations', scoreBefore: 79, scoreAfter: 84,
    interviewCount: null, interviewAfterDays: 21, credentialCode: null, tag: 'Verified link earned',
    quote: "I didn't have a resume. I had a notes app.",
    story: "After four years at home with my kids I had no resume: volunteering, a few freelance invoices, half a certificate, all scattered in my phone. I pasted everything into “start from scratch” with a project coordinator posting.\n\nPassthrough turned the mess into sections a robot could read. The first scan was 79, a pass but short of the credential. Two retries later it was 84, with a link I put on every application. I'd braced for the gap to be the first thing anyone saw. It was one line.",
    moral: "You don't need a better history. You need your real one, translated.",
  },
]

// Shape matches GET /api/stats `hotCategories[7|30]`.
export const SAMPLE_HOT = {
  7: [['software_engineering', 412, 12], ['product_management', 187, 8], ['data_science', 164, 15], ['marketing', 143, 3], ['sales', 131, 6], ['finance', 98, 2], ['operations', 92, 4], ['design', 77, 9], ['healthcare', 61, 11], ['education', 44, 1], ['other', 36, null], ['legal', 29, 5]],
  30: [['software_engineering', 1710, 9], ['product_management', 802, 6], ['data_science', 690, 11], ['marketing', 611, 2], ['sales', 540, 5], ['finance', 402, 3], ['operations', 377, 1], ['design', 318, 7], ['healthcare', 251, 8], ['education', 190, 2], ['other', 150, null], ['legal', 118, 4]],
}

// The sample verification an employer would see (the "Passthrough Verified" mock card).
export const SAMPLE_VERIFICATION = { name: 'Alex', field: 'Product Management', score: 91, code: 'K7M2QX9P4A' }

export function buildFaq({ maxFixRetries, freeScansPerDay, anonScansPerHour, badgeThreshold }) {
  const retries = maxFixRetries === 1 ? '1 free retry' : `${maxFixRetries} free retries`
  const anon = anonScansPerHour === 1 ? 'once' : `${anonScansPerHour} times`
  const daily = freeScansPerDay === 1 ? '1 scan' : `${freeScansPerDay} scans`
  return [
    { id: 'faq-guarantee', q: 'Does Passthrough guarantee an interview?', a: "No — nobody honestly can. Passthrough reduces the chance that a parsing, formatting or keyword problem is why you're rejected, and gives employers a way to check that your file is genuine. What happens next is still up to you and the employer." },
    { id: 'faq-66', q: 'Where does the interview figure come from?', a: "It's the share of applicants who told us, in a follow-up after their fixed resume was delivered, that it led to an interview. It is self-reported, so it reflects people who chose to answer, and it is only shown once enough people have." },
    { id: 'faq-verified', q: 'What does “Verified” actually prove?', a: `That the resume scored ${badgeThreshold} or higher against our ATS check, and that the exact file has not been modified since — we fingerprint the document at verification time and re-check it every time the link is opened. It isn't an endorsement from any employer, and a fingerprint mismatch on a copy someone re-saved or converted doesn't prove tampering; it just means ask for the original.` },
    { id: 'faq-noresume', q: "I don't have a resume. Can I still use this?", a: 'Yes. Choose “Start from scratch” and paste a brain dump, an old resume, or just describe your background, and we’ll structure it.' },
    { id: 'faq-retry', q: "What if my resume still doesn't pass?", a: `The AI makes multiple rewrite attempts, you get ${retries}, and if those still don't get you past the verification threshold, you get a free credit for your next resume.` },
    { id: 'faq-ats', q: "Does it match how my target company's ATS works?", a: "The scoring is built around how employers hire with Workday, Greenhouse, iCIMS, Taleo, Lever and SuccessFactors. It's Passthrough's own scoring, not a feed from those vendors, so treat it as a strong guide rather than a guarantee." },
    { id: 'faq-account', q: 'Do I need an account to scan?', a: `No. Scan ${anon} an hour without one, or create a free account for ${daily} a day.` },
  ]
}

// The six short pull-quotes under the stories. PLACEHOLDERS: write your own, or empty the array to hide the
// block. While QUOTES_ARE_SAMPLE is true the page labels the block as illustrative; set it to false once
// every line below is a real, permitted quote.
export const QUOTES_ARE_SAMPLE = true
export const PULL_QUOTES = [
  { text: 'The report told me exactly which keywords I was missing.', who: 'Marketing manager' },
  { text: 'I scanned one resume against five postings. Three failed hard. Now I apply to fewer, better-matched roles.', who: 'Marketing, laid off' },
  { text: 'Free scan first, pay after I saw my number. Fair.', who: 'Nurse switching hospitals' },
  { text: 'A recruiter told me she checked the link before she called.', who: 'Sales development rep' },
  { text: 'Two free retries is what made me trust it.', who: 'Operations lead' },
  { text: 'Finally, a score I can explain to my mum.', who: 'Junior designer' },
]

// Receipt demo: the one line "the recruiter was sent", and what a one-character edit does to its fingerprint.
export const TAMPER_DEMO = {
  original: 'Led the roadmap for 3 squads; ran 14 A/B tests that lifted checkout conversion by 12%.',
  edit: ['12%', '19%'],
}

// Where to put the Verified link (the placement tabs). `sig` is rendered as the email-signature mock.
export const PLACEMENTS = [
  { id: 'email', label: 'Email signature', tip: 'Use the PNG badge here. Most email clients can’t render SVG.' },
  { id: 'linkedin', label: 'LinkedIn', tip: 'Add the link to Featured or About. Recruiters click it, see the score, and the page points back to you.' },
  { id: 'header', label: 'Resume header', tip: 'One line under your contact details. Anyone holding the PDF can check it.' },
  { id: 'form', label: 'Application form', tip: 'Most application forms have a link field nobody uses. Put the receipt there.' },
]

// What the ATS "read" of the before/after resumes, shown under the score bars. Illustrative, like the scores.
export const ROBOT_READ = {
  before: [['Email', 'bad', '✕ not found'], ['Work history', 'bad', '✕ merged with skills'], ['Dates', 'bad', '✕ unreadable'], ['Keywords', 'bad', 'missing 4 the job asks for']],
  after: [['Email', 'good', '✓ found'], ['Work history', 'good', '✓ 4 roles, in order'], ['Dates', 'good', '✓ readable'], ['Keywords', 'good', 'all 4 matched truthfully']],
}
