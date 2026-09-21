import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fetchJobDescriptionFromUrl, isBlockedHost, htmlToText, looksLikeListingPage } from '../src/services/jd.parser.js'

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
  it('caps returned text at 5000 chars', async () => {
    mockFetch(() => html('<p>' + 'word '.repeat(4000) + '</p>'))
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/long')
    expect(r.text.length).toBeLessThanOrEqual(5000)
  })
  it('fails soft (no throw) when fetch itself throws', async () => {
    mockFetch(() => { throw new Error('network down') })
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/x')
    expect(r.success).toBe(false)
  })
})
