import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { checkUrlIsSafeToFetch } from '../src/lib/ssrfGuard.js'

// checkUrlIsSafeToFetch is async: after the static checks it resolves the hostname
// via DNS-over-HTTPS (Cloudflare) and re-checks every answer, failing CLOSED.
// The stub below plays the resolver, keyed by hostname.
const realFetch = globalThis.fetch
const DNS = {
  'private.example':  { A: ['169.254.169.254'] },            // ordinary static A record pointing at the metadata service
  'private6.example': { AAAA: ['fd12:3456::1'] },
  'mixed.example':    { A: ['93.184.216.34', '10.0.0.5'] },   // one bad answer poisons the lot
  'nx.example':       { A: [], AAAA: [] },                    // no records at all
  'cname.example':    { A: ['93.184.216.34'], cname: true },  // CNAME chain + public A
}
let dohCalls
beforeEach(() => {
  dohCalls = []
  globalThis.fetch = async url => {
    const u = new URL(String(url))
    dohCalls.push(u.searchParams.get('name') + ':' + u.searchParams.get('type'))
    const name = u.searchParams.get('name')
    if (name === 'dohfail.example') return new Response('boom', { status: 500 })
    if (name === 'dohbad.example') return new Response('not json', { status: 200 })
    const rec = DNS[name] || { A: ['93.184.216.34'], AAAA: [] }
    const type = u.searchParams.get('type')
    const Answer = []
    if (rec.cname && type === 'A') Answer.push({ type: 5, data: 'target.example.' })
    for (const ip of (type === 'A' ? rec.A : rec.AAAA) || []) Answer.push({ type: type === 'A' ? 1 : 28, data: ip })
    return new Response(JSON.stringify({ Answer }), { status: 200, headers: { 'content-type': 'application/dns-json' } })
  }
})
afterEach(() => { globalThis.fetch = realFetch })

const blocked = async u => (await checkUrlIsSafeToFetch(u)) !== null

describe('ssrfGuard — must BLOCK', () => {
  const MUST_BLOCK = {
    'loopback names': ['http://localhost/', 'http://LOCALHOST/', 'http://foo.localhost/'],
    // Fully-qualified names with a trailing dot are the SAME host; the exact-match
    // and suffix checks used to miss them entirely.
    'trailing-dot FQDNs': ['http://localhost./', 'http://foo.internal./', 'http://metadata.google.internal./computeMetadata/v1/', 'http://printer.local./'],
    'internal suffixes': ['http://foo.internal/', 'http://db.lan/', 'http://x.local/', 'http://x.corp/', 'http://x.home.arpa/'],
    'wildcard-DNS smuggling': ['http://127.0.0.1.nip.io/', 'http://169.254.169.254.sslip.io/', 'http://anything.localtest.me/'],
    'IPv4 loopback & obfuscations (URL parser normalises these)': ['http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://017700000001/', 'http://0/', 'http://0.0.0.0/'],
    'IPv4 private / link-local / CGNAT / metadata': ['http://10.0.0.1/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/'],
    'IPv4 reserved / documentation / benchmarking': ['http://192.0.0.1/', 'http://192.0.2.5/', 'http://198.18.0.1/', 'http://198.19.255.255/', 'http://198.51.100.7/', 'http://203.0.113.9/'],
    'IPv6 loopback / unspecified': ['http://[::1]/', 'http://[::]/'],
    'IPv4-mapped IPv6': ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[::ffff:10.0.0.1]/'],
    'IPv4-translated (SIIT) IPv6': ['http://[::ffff:0:7f00:1]/'],
    'NAT64 embedding a private IPv4': ['http://[64:ff9b::a9fe:a9fe]/'],
    '6to4 / Teredo / documentation IPv6': ['http://[2002:7f00:1::]/', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'http://[2001:db8::1]/'],
    // fe80::/10 spans fe80–febf; only fe80::/16 used to be blocked.
    'full link-local fe80::/10': ['http://[fe80::1]/', 'http://[fe90::1]/', 'http://[fea0::1]/', 'http://[febf::1]/'],
    'site-local / unique-local IPv6': ['http://[fec0::1]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/'],
    'non-http schemes': ['file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)', 'gopher://example.com/'],
    'credentials-in-URL to a private host': ['http://user:pw@127.0.0.1/', 'http://example.com@127.0.0.1/'],
    'garbage': ['not a url', '', 'http://'],
  }
  for (const [group, urls] of Object.entries(MUST_BLOCK))
    for (const u of urls)
      it(`${group}: ${u || '(empty)'}`, async () => expect(await blocked(u)).toBe(true))
})

describe('ssrfGuard — must ALLOW real public sites', () => {
  for (const u of ['http://example.com/', 'https://jobs.lever.co/acme/123', 'https://boards.greenhouse.io/acme/jobs/1',
    'http://8.8.8.8/', 'https://1.1.1.1/', 'http://[2606:4700:4700::1111]/', 'https://careers.example.co.uk/role?id=5',
    'https://api.example.com:8443/x'])
    it(`allows ${u}`, async () => expect(await blocked(u)).toBe(false))
})

describe('ssrfGuard — result shape', () => {
  it('returns null when safe and a human-readable reason string when blocked', async () => {
    expect(await checkUrlIsSafeToFetch('https://example.com/')).toBeNull()
    expect(typeof (await checkUrlIsSafeToFetch('http://127.0.0.1/'))).toBe('string')
  })
})

describe('ssrfGuard — DNS resolution layer (fails CLOSED)', () => {
  it('blocks a normal-looking hostname whose A record points at a private IP (no rebinding needed)', async () => {
    expect(await blocked('https://private.example/job')).toBe(true)
    expect(await blocked('https://private6.example/job')).toBe(true)
  })
  it('one private answer among several public ones blocks the host', async () => {
    expect(await blocked('https://mixed.example/')).toBe(true)
  })
  it('a hostname with no A/AAAA records is unsafe, not "unknown"', async () => {
    expect(await blocked('https://nx.example/')).toBe(true)
  })
  it('a DoH lookup failure (HTTP 500, or a malformed body) blocks — never fails open', async () => {
    expect(await blocked('https://dohfail.example/')).toBe(true)
    expect(await blocked('https://dohbad.example/')).toBe(true)
  })
  it('a DoH network error blocks', async () => {
    globalThis.fetch = async () => { throw new Error('offline') }
    expect(await blocked('https://anything.example/')).toBe(true)
  })
  it('ignores CNAME entries mixed into the answer and judges the addresses', async () => {
    expect(await blocked('https://cname.example/')).toBe(false)
  })
  it('never spends a DNS lookup on literal IPs or statically-blocked names', async () => {
    for (const u of ['http://127.0.0.1/', 'http://[::1]/', 'http://8.8.8.8/', 'http://localhost/', 'http://x.internal/', 'file:///etc/passwd'])
      await checkUrlIsSafeToFetch(u)
    expect(dohCalls).toHaveLength(0)
  })
  it('queries both A and AAAA for a public hostname', async () => {
    await checkUrlIsSafeToFetch('https://jobs.example.com/x')
    expect(dohCalls.sort()).toEqual(['jobs.example.com:A', 'jobs.example.com:AAAA'])
  })
})
