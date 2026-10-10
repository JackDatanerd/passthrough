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
    story: "I'd been applying for two months and assumed the market was just brutal. The scan showed my resume was being read as one big image-heavy block — half my skills never got parsed.\n\nI fixed it, got the Verified link, and put it in my application email. The recruiter told me later the link is why she opened my file first.",
  },
  {
    id: 'sample-2', displayName: 'Daniel M.', roleCategory: 'healthcare', scoreBefore: 55, scoreAfter: 91,
    interviewCount: 3, interviewAfterDays: 14, credentialCode: null,
    quote: 'I changed careers. Passthrough translated my experience into the language the job posts use.',
    story: 'Ten years in logistics, applying to hospital operations. My resume was true, but none of the words matched. The keyword gap list read like a translation guide.\n\nTwo of my three interviews mentioned the verification badge in my email signature.',
  },
  {
    id: 'sample-3', displayName: 'Priya S.', roleCategory: 'marketing', scoreBefore: 41, scoreAfter: 84,
    interviewCount: 2, interviewAfterDays: 5, credentialCode: null,
    quote: 'I was laid off on a Monday. By the next Friday I had two calls booked.',
    story: 'I scanned the same resume against five different job descriptions. Three failed hard. Seeing exactly why changed how I applied: fewer roles, better matched.\n\nI sent the Verified link with every application. It felt like showing receipts instead of asking people to trust me.',
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
    { id: 'faq-guarantee', q: 'Does Passthrough guarantee an interview?', a: "No — nobody honestly can. Passthrough removes the ATS filter as the reason you're rejected, and gives employers proof your resume is genuine. What happens next is still up to you and the employer." },
    { id: 'faq-66', q: 'Where does the interview figure come from?', a: "It's the share of applicants who told us, in a follow-up after their fixed resume was delivered, that it led to an interview. It is self-reported, so it reflects people who chose to answer, and it is only shown once enough people have." },
    { id: 'faq-verified', q: 'What does “Verified” actually prove?', a: `That the resume scored ${badgeThreshold} or higher against our ATS check, and that the exact file has not been modified since — we fingerprint the document at verification time and re-check it every time the link is opened.` },
    { id: 'faq-retry', q: "What if my resume still doesn't pass?", a: `The AI makes multiple rewrite attempts, you get ${retries}, and if it still falls short of the verification threshold we bank a free fix credit on your account.` },
    { id: 'faq-account', q: 'Do I need an account to scan?', a: `No. Scan ${anon} an hour without one, or create a free account for ${daily} a day.` },
  ]
}
