import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fetchJobDescriptionFromUrl, isBlockedHost, htmlToText, looksLikeListingPage, extractPageTitle } from '../src/services/jd.parser.js'

const realFetch = globalThis.fetch
let fetched
// The SSRF guard resolves hostnames via DNS-over-HTTPS before any page is fetched.
// Answer those lookups here (public IP unless the test says otherwise) and keep
// them out of `fetched`, which records only real page requests.
let dnsAnswers
function mockFetch(handler) {
  fetched = []
  dnsAnswers = {}
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.startsWith('https://cloudflare-dns.com/dns-query')) {
      const q = new URL(u); const name = q.searchParams.get('name'); const type = q.searchParams.get('type')
      const ips = dnsAnswers[name] || ['93.184.216.34']
      const Answer = type === 'A' ? ips.filter(i => !i.includes(':')).map(data => ({ type: 1, data })) : ips.filter(i => i.includes(':')).map(data => ({ type: 28, data }))
      return new Response(JSON.stringify({ Answer }), { status: 200 })
    }
    fetched.push(u); return handler(u, opts)
  }
}
const html = (body, headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
const JOB = `<html><body><h1>Senior Engineer</h1><p>${'We are hiring a senior engineer to build reliable systems with Python, Kubernetes and Terraform. '.repeat(4)}</p></body></html>`

afterEach(() => { globalThis.fetch = realFetch })

describe('isBlockedHost', () => {
  it('blocks the platforms and their subdomains', () => {
    for (const h of ['linkedin.com', 'www.linkedin.com', 'uk.linkedin.com', 'lnkd.in', 'facebook.com', 'm.facebook.com', 'fb.com', 'instagram.com', 'LinkedIn.com.'])
      expect(isBlockedHost(h)).toBe(true)
  })
  // The old check was hostname.includes(domain), which blocked unrelated employers.
  it('does NOT block unrelated domains that merely CONTAIN a blocked name', () => {
    for (const h of ['notlinkedin.com', 'myfacebook.com', 'linkedin.com.evil.example', 'careers-fb.com', 'jobs.example.com'])
      expect(isBlockedHost(h)).toBe(false)
  })
})

describe('htmlToText', () => {
  it('strips tags, scripts, styles, comments and nav/header/footer/aside', () => {
    const t = htmlToText('<nav>MENU</nav><script>evil()</script><style>.a{}</style><!-- hidden --><p>Hello <b>world</b></p><footer>FOOT</footer>')
    expect(t).toBe('Hello world')
  })
  // REGRESSION: entities were never decoded, so "nbsp"/"amp"/"quot" became
  // "missing keywords" shown to users.
  it('decodes entities so they do not leak into keyword extraction', () => {
    const t = htmlToText('<p>Kubernetes&nbsp;Docker &amp; Terraform &quot;microservices&quot; O&#39;Reilly &#x2019;s</p>')
    expect(t).not.toContain('nbsp')
    expect(t).not.toContain('&amp;')
    expect(t).not.toContain('&quot;')
    expect(t).toContain('Kubernetes Docker & Terraform')
    expect(t).toContain("O'Reilly")
  })
  it('collapses whitespace and tolerates empty/undefined input', () => {
    expect(htmlToText('  a \n\n  b\t c ')).toBe('a b c')
    expect(htmlToText('<h2>Requirements</h2><ul><li>Python</li><li>SQL</li></ul>')).toBe('Requirements\nPython\nSQL')
    expect(htmlToText('')).toBe('')
    expect(htmlToText(undefined)).toBe('')
  })
})

describe('looksLikeListingPage', () => {
  it('needs two independent listing signals', () => {
    expect(looksLikeListingPage('120 jobs found. Page 1 of 12')).toBe(true)
    expect(looksLikeListingPage('120 jobs found in your area')).toBe(false)
    expect(looksLikeListingPage('a normal single job description with details')).toBe(false)
  })
})

describe('fetchJobDescriptionFromUrl', () => {
  it('rejects an invalid URL without fetching', async () => {
    mockFetch(() => html(JOB))
    const r = await fetchJobDescriptionFromUrl('not a url')
    expect(r.success).toBe(false)
    expect(fetched).toHaveLength(0)
  })
  it('refuses LinkedIn up-front (blocked:true) without fetching', async () => {
    mockFetch(() => html(JOB))
    const r = await fetchJobDescriptionFromUrl('https://www.linkedin.com/jobs/view/1')
    expect(r.blocked).toBe(true)
    expect(fetched).toHaveLength(0)
  })
  it('does not refuse a lookalike employer domain', async () => {
    mockFetch(() => html(JOB))
    const r = await fetchJobDescriptionFromUrl('https://notlinkedin.com/careers/1')
    expect(r.success).toBe(true)
  })
  it('returns extracted text for a normal page', async () => {
    mockFetch(() => html(JOB))
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/1')
    expect(r.success).toBe(true)
    expect(r.text).toContain('Senior Engineer')
    expect(r.text).toContain('Kubernetes')
  })
  it('never fetches a private address', async () => {
    mockFetch(() => html(JOB))
    for (const u of ['http://127.0.0.1/', 'http://localhost./x', 'http://169.254.169.254/latest/meta-data/', 'http://[fe90::1]/'])
      expect((await fetchJobDescriptionFromUrl(u)).success).toBe(false)
    expect(fetched).toHaveLength(0)
  })
  it('refuses a public-looking hostname that RESOLVES to a private address (never requests the page)', async () => {
    mockFetch(() => html(JOB))
    dnsAnswers['sneaky.example.com'] = ['169.254.169.254']
    const r = await fetchJobDescriptionFromUrl('https://sneaky.example.com/job')
    expect(r.success).toBe(false)
    expect(fetched).toHaveLength(0)
  })
  it('re-checks EVERY redirect hop: a public URL redirecting to the metadata service is not followed', async () => {
    mockFetch(url => url.startsWith('https://public.example.com')
      ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
      : html(JOB))
    const r = await fetchJobDescriptionFromUrl('https://public.example.com/job')
    expect(r.success).toBe(false)
    expect(fetched).toEqual(['https://public.example.com/job'])   // the second hop was never requested
  })
  it('follows a safe redirect (relative Location resolved against the current URL)', async () => {
    mockFetch(url => url.endsWith('/old')
      ? new Response(null, { status: 301, headers: { location: '/new' } })
      : html(JOB))
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/old')
    expect(r.success).toBe(true)
    expect(fetched).toEqual(['https://jobs.example.com/old', 'https://jobs.example.com/new'])
  })
  it('gives up after too many redirects', async () => {
    mockFetch(() => new Response(null, { status: 302, headers: { location: 'https://jobs.example.com/again' } }))
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/loop')
    expect(r.success).toBe(false)
  })
  it('rejects non-2xx responses', async () => {
    mockFetch(() => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }))
    expect((await fetchJobDescriptionFromUrl('https://jobs.example.com/x')).success).toBe(false)
  })
  // REGRESSION: a PDF/zip under the size cap used to be UTF-8-decoded into garbage and scored as a JD.
  it('rejects binary content types (pdf/zip/image)', async () => {
    for (const ct of ['application/pdf', 'application/zip', 'image/png', 'application/octet-stream']) {
      mockFetch(() => new Response('%PDF-1.7 ' + 'x'.repeat(500), { status: 200, headers: { 'content-type': ct } }))
      const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/doc')
      expect(r.success).toBe(false)
      expect(r.message).toMatch(/web page/i)
    }
  })
  it('rejects a page over the 500KB cap', async () => {
    mockFetch(() => html('a'.repeat(600_000)))
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/huge')
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/too large/i)
  })
  it('rejects a page with too little text', async () => {
    mockFetch(() => html('<p>tiny</p>'))
    expect((await fetchJobDescriptionFromUrl('https://jobs.example.com/empty')).success).toBe(false)
  })
  it('flags a multi-job listing page instead of scoring it', async () => {
    mockFetch(() => html('<p>' + 'Browse roles. 250 jobs found. Page 1 of 25. Sort by: newest. '.repeat(4) + '</p>'))
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/all')
    expect(r.success).toBe(false)
    expect(r.blocked).toBe(true)
  })
  it('honours a declared non-UTF-8 charset (no mojibake)', async () => {
    const latin1 = Uint8Array.from(Buffer.from('<p>' + 'Café résumé engineer required for a senior position building things. '.repeat(3) + '</p>', 'latin1'))
    mockFetch(() => new Response(latin1, { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } }))
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/fr')
    expect(r.success).toBe(true)
    expect(r.text).toContain('Café résumé')
  })
  it('caps returned text at 20000 chars (createScan fits it down to MAX_JD_CHARS)', async () => {
    mockFetch(() => html('<p>' + 'word '.repeat(4000) + '</p>'))
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/long')
    expect(r.text.length).toBeLessThanOrEqual(20000)
  })
  it('fails soft (no throw) when fetch itself throws', async () => {
    mockFetch(() => { throw new Error('network down') })
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/x')
    expect(r.success).toBe(false)
  })
})

// ── htmlToText: correctness + resistance to quadratic-time input ────────────
describe('htmlToText — correctness', () => {
  it('removes script, style, comments and nav/header/footer/aside blocks, keeps the posting', () => {
    const html = '<html><head><style>.a{color:red}</style><script>var x=1</script></head><body>' +
      '<header>Site header</header><nav><a>Home</a></nav><!-- hidden --><main><h1>Backend Engineer</h1>' +
      '<p>Build APIs &amp; services.</p></main><aside>Ads</aside><footer>Footer links</footer></body></html>'
    const t = htmlToText(html)
    expect(t).toContain('Backend Engineer')
    expect(t).toContain('Build APIs & services.')
    for (const junk of ['Site header', 'Home', 'hidden', 'Ads', 'Footer links', 'color:red', 'var x'])
      expect(t).not.toContain(junk)
  })
  it('is case-insensitive about tag names, and tolerates whitespace in closers', () => {
    expect(htmlToText('a <SCRIPT>bad()</SCRIPT > b <STYLE>x{}</style> c')).toBe('a b c')
  })
  it('does not treat similarly-named tags as blocks (<navigation> is not <nav>)', () => {
    expect(htmlToText('<navigation>keep me</navigation>')).toContain('keep me')
  })
  it('an unclosed <script>/<style>/comment swallows the rest, exactly as a browser would', () => {
    expect(htmlToText('visible <script>alert(1) invisible')).toBe('visible')
    expect(htmlToText('visible <!-- never closed invisible')).toBe('visible')
  })
  it('an unclosed <nav> leaves the text in place (only its tag is dropped)', () => {
    expect(htmlToText('<nav>menu text')).toBe('menu text')
  })
  it('keeps a literal "<>" and a lone "<" as text', () => {
    expect(htmlToText('a <> b < c')).toBe('a <> b < c')
  })
  it('handles nested/adjacent blocks and repeated blocks', () => {
    expect(htmlToText('<nav>a</nav>KEEP<nav>b</nav>ALSO<script>x</script>END')).toBe('KEEP ALSO END')
  })
})

describe('htmlToText — hostile input must stay linear (was 40-65s of CPU at 500KB)', () => {
  const N = 500_000
  const cases = {
    'unclosed <script':  '<script '.repeat(N / 8),
    'unclosed <style':   '<style '.repeat(N / 7),
    'unclosed <!--':     '<!-- '.repeat(N / 5),
    'unclosed <nav':     '<nav '.repeat(N / 5),
    'unclosed <header':  '<header '.repeat(N / 8),
    'run of "<" (no >)': '<'.repeat(N),
    'many "<a" no ">"':  '<a'.repeat(N / 2),
    'mixed openers':     '<script <style <nav <!-- <header <footer <aside '.repeat(N / 48),
  }
  for (const [name, html] of Object.entries(cases)) {
    it(`${name}`, () => {
      const t0 = Date.now()
      htmlToText(html)
      expect(Date.now() - t0).toBeLessThan(750)
    })
  }
  it('the full text pipeline (flatten → boilerplate → listing detection) is also linear on hostile text', () => {
    const t0 = Date.now()
    looksLikeListingPage(htmlToText('$1 - '.repeat(100_000) + '12 jobs '.repeat(60_000)))
    expect(Date.now() - t0).toBeLessThan(1500)
  })
})

// ─── Scan/ATS independent pass: a fetched page's title becomes the JD's first line ──
describe('extractPageTitle / job title on the non-JSON-LD path', () => {
  it('prefers the first <h1> (tags inside it flattened; script text never a candidate)', () => {
    const page = '<title>Senior Data Analyst - Acme Careers</title><script>var s="<h1>bad</h1>"</script><h1 class="t">Senior <b>Data</b> Analyst</h1>'
    expect(extractPageTitle(page)).toBe('Senior Data Analyst')
  })
  it('falls back to the first segment of <title>', () => {
    expect(extractPageTitle('<title>Backend Engineer | Acme Corp</title><div>x</div>')).toBe('Backend Engineer')
  })
  it('rejects generic / missing / unclosed headings', () => {
    expect(extractPageTitle('<title>Careers at Acme</title><h1>Careers</h1>')).toBe('')
    expect(extractPageTitle('<div>no headings</div>')).toBe('')
    expect(extractPageTitle('<h1>Broken <p>text')).toBe('')
  })
  it('the fetched text starts with the title on its own line so deriveJobTitle can use it', async () => {
    const body = `<html><head><title>Data Engineer | Acme</title></head><body><h1>Data Engineer</h1><p>${'Build pipelines with Python, Airflow and dbt for analytics teams across the company. '.repeat(4)}</p></body></html>`
    mockFetch(() => html(body))
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/de')
    expect(r.success).toBe(true)
    expect(r.text.split('\n')[0]).toBe('Data Engineer')
    expect(r.text.match(/Data Engineer/g)).toHaveLength(1)   // not duplicated when the body already opens with it
  })
  it('adds the title when the flattened body does not open with it', async () => {
    const body = `<html><head><title>Data Engineer | Acme</title></head><body><h1>Data Engineer</h1><div>Join our team!</div><p>${'Build pipelines with Python, Airflow and dbt for analytics teams across the company. '.repeat(4)}</p></body></html>`
    mockFetch(() => html(body))
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/de2')
    expect(r.text.split('\n')[0]).toBe('Data Engineer')
  })
})

describe('scan/ats round 5: posting structure survives the fetch', () => {
  const NURSE = '<h1>Registered Nurse</h1><p>Riverside Hospital delivers compassionate community healthcare across the region with dedicated clinicians and volunteers.</p><h2>About Riverside Hospital</h2><p>Founded in 1950 our hospital campus serves families through heritage programs and community outreach events.</p><h2>Requirements</h2><ul><li>Active nursing licence</li><li>Patient assessment</li><li>Medication administration</li><li>Wound care</li><li>Electronic charting</li><li>Triage experience</li></ul><h2>Benefits</h2><ul><li>Pension plan</li><li>Tuition assistance</li></ul>'
  it('block tags become line breaks so headings stay on their own lines', () => {
    const t = htmlToText(NURSE)
    expect(t.split('\n')).toContain('Requirements')
    expect(t.split('\n')).toContain('Benefits')
    expect(t.split('\n')).toContain('Patient assessment')
  })
  it('a fetched posting scores like the same posting pasted with its line breaks', async () => {
    const { scoreResume } = await import('../src/services/ats.service.js')
    const resume = `Jane Doe\njane@x.com\n\nSummary\nRegistered nurse delivering compassionate care to patients across the community every single day of the week.\n\nExperience\n• Performed patient assessment, medication administration and wound care for 30 patients per shift\n• Led triage for the emergency unit and electronic charting for the team\n• Managed discharge planning for the hospital\n\nEducation\nBSN Nursing\n\nSkills\nTriage, wound care, charting, patient assessment, medication administration`
    const fetchedScore = scoreResume(resume, htmlToText(NURSE)).keywordScore
    const pastedScore = scoreResume(resume, NURSE.replace(/<\/(h\d|p|li|ul)>/g, '\n').replace(/<[^>]+>/g, '')).keywordScore
    expect(fetchedScore).toBe(pastedScore)
    expect(fetchedScore).toBeGreaterThanOrEqual(70)
  })
  it('keeps the line structure of a JSON-LD description (markup and plain text)', async () => {
    const { extractJobPostingText } = await import('../src/services/jd.parser.js')
    const mk = d => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Backend Engineer', description: d })}</script>`
    const filler = ' We build payment rails for customers across many markets.'.repeat(4)
    const a = extractJobPostingText(mk(`<p>About the team.${filler}</p><h3>Requirements</h3><ul><li>Python</li><li>SQL</li></ul>`))
    expect(a.split('\n')).toContain('Requirements')
    expect(a.split('\n')).toContain('Python')
    const b = extractJobPostingText(mk(`About the team.${filler}\nRequirements\nPython\nSQL`))
    expect(b.split('\n')).toContain('Requirements')
  })
  it('does not follow a redirect that lands on a blocked host', async () => {
    mockFetch(url => url.startsWith('https://short.example.com')
      ? new Response(null, { status: 302, headers: { location: 'https://www.linkedin.com/jobs/view/123' } })
      : html(JOB))
    const r = await fetchJobDescriptionFromUrl('https://short.example.com/x')
    expect(r.success).toBe(false)
    expect(fetched).toEqual(['https://short.example.com/x'])
  })
})
