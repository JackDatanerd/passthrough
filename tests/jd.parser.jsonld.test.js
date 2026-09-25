import { describe, it, expect, afterEach } from 'vitest'
import { fetchJobDescriptionFromUrl, extractJobPostingText } from '../src/services/jd.parser.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
function serve(body) {
  globalThis.fetch = async url => {
    const u = String(url)
    if (u.startsWith('https://cloudflare-dns.com/dns-query')) {
      const type = new URL(u).searchParams.get('type')
      return new Response(JSON.stringify({ Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] }), { status: 200 })
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
  }
}
const ld = obj => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`
const LONG = 'Build reliable distributed systems in Go and Kubernetes, own services end to end, mentor engineers, and partner with product. '.repeat(4)
const posting = over => ({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Staff Platform Engineer', hiringOrganization: { '@type': 'Organization', name: 'Acme' }, description: `<p>${LONG}</p><ul><li>Terraform</li></ul>`, ...over })

describe('JD URLs — schema.org JobPosting JSON-LD', () => {
  it('reads the full posting from a client-rendered page whose visible HTML is an empty shell', async () => {
    serve(`<html><head>${ld(posting())}</head><body><div id="root"></div></body></html>`)
    const r = await fetchJobDescriptionFromUrl('https://acme.wd1.myworkdayjobs.com/en-US/careers/job/x')
    expect(r.success).toBe(true)
    expect(r.text).toContain('Staff Platform Engineer')
    expect(r.text).toContain('Company: Acme')
    expect(r.text).toContain('Kubernetes')
    expect(r.text).toContain('Terraform')
    expect(r.text).not.toContain('<p>')
  })
  it('finds the posting inside @graph and when @type is an array', async () => {
    expect(extractJobPostingText(`<html>${ld({ '@graph': [{ '@type': 'WebSite' }, posting({ '@type': ['JobPosting'] })] })}</html>`)).toContain('Staff Platform Engineer')
  })
  it('decodes a double-escaped description', () => {
    const t = extractJobPostingText(`<html>${ld(posting({ description: `&lt;p&gt;${LONG}&lt;/p&gt;` }))}</html>`)
    expect(t).not.toMatch(/&lt;|<p>/)
    expect(t).toContain('Go and Kubernetes')
  })
  it('several postings on one page is a LISTING, not a job — structured path declines', () => {
    expect(extractJobPostingText(`<html>${ld([posting(), posting({ title: 'Other', identifier: { value: 2 } })])}</html>`)).toBe(null)
  })
  it('a too-thin description falls back to the visible page text', async () => {
    serve(`<html>${ld(posting({ description: 'Short.' }))}<body><p>${'Fallback body text about the role, Python and SQL. '.repeat(6)}</p></body></html>`)
    const r = await fetchJobDescriptionFromUrl('https://jobs.example.com/1')
    expect(r.success).toBe(true)
    expect(r.text).toContain('Fallback body text')
  })
  it('ignores malformed JSON-LD and non-JobPosting types', () => {
    expect(extractJobPostingText(`<script type="application/ld+json">{not json</script>${ld({ '@type': 'Organization', name: 'x' })}`)).toBe(null)
  })
  it('an unclosed <script> never hangs or throws', () => {
    expect(extractJobPostingText('<script '.repeat(50000))).toBe(null)
  })
})
