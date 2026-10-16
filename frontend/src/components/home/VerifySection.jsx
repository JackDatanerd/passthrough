import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../../lib/api'
import { buildBadgeEmbeds } from '../../lib/badgeEmbed'
import CopyButton from '../ui/CopyButton'
import { extractVerificationCode } from '../../lib/verificationCode'
import { sha256Text } from '../../lib/sha256'
import { SAMPLE_VERIFICATION, TAMPER_DEMO, PLACEMENTS } from '../../lib/homeContent'

// "The receipt": what an employer sees when they open a candidate's link, a hands-on demo of what the
// fingerprint does, where to put the link, and the snippet to paste. Everything on the ticket is an
// illustration (labelled as one); the only live behaviour is the tamper test, which hashes a line of
// SAMPLE text in the browser — the real check (/check) does the same with the real file and uploads nothing.
const FORMATS = [['html', 'HTML'], ['markdown', 'Markdown'], ['link', 'Plain link']]
const NAV_KEYS = { ArrowRight: 1, ArrowLeft: -1 }

function sampleEmbeds() {
  let root = String(api.defaults.baseURL || '/api')
  try { root = new URL(root, window.location.origin).href.replace(/\/+$/, '') } catch (_) { /* keep as is */ }
  const pageUrl = `${window.location.origin}/v/${SAMPLE_VERIFICATION.code}`
  const e = buildBadgeEmbeds(root, SAMPLE_VERIFICATION.code, pageUrl)
  return { html: e.html, markdown: e.markdown, link: pageUrl }
}

// 64 hex chars as four groups of 8; a group that differs from the issued fingerprint is highlighted.
const groups = (h) => [h.slice(0, 8), h.slice(8, 16), h.slice(16, 24), h.slice(24, 32)]
function Fingerprint({ hash, against, label }) {
  const ref = against ? groups(against) : null
  return (
    <div className="flex flex-wrap gap-2 my-2 font-mono text-[13.5px] font-semibold" aria-label={label}>
      {groups(hash).map((g, i) => (
        <span key={i} data-diff={ref && ref[i] !== g ? 'true' : undefined}
          className={`px-1.5 py-0.5 rounded transition-colors ${ref && ref[i] !== g ? 'bg-amber-50 text-amber-800' : 'bg-gray-100'}`}>{g}</span>
      ))}
    </div>
  )
}

const maskMain = 'radial-gradient(circle 13px at 0 100%,#0000 96%,#000),radial-gradient(circle 13px at 100% 100%,#0000 96%,#000)'
const maskStub = 'radial-gradient(circle 13px at 0 0,#0000 96%,#000),radial-gradient(circle 13px at 100% 0,#0000 96%,#000)'

function Ticket({ exact, hash, issued }) {
  const rows = [['Keyword Match', 92], ['Formatting', 94], ['Sections', 90], ['Content', 88]]
  return (
    <div className="drop-shadow-[0_12px_24px_rgba(15,23,42,0.16)]" aria-label="Example of the page an employer sees">
      <div className="bg-white rounded-t-2xl" style={{ WebkitMask: maskMain, WebkitMaskComposite: 'source-in', mask: maskMain, maskComposite: 'intersect' }}>
        <div aria-hidden="true" className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-200 rounded-t-2xl">
          {[0, 1, 2].map(i => <i key={i} className="w-2.5 h-2.5 rounded-full bg-gray-300" />)}
          <span className="flex-1 ml-2 bg-white border border-gray-200 rounded-md px-2.5 py-1 font-mono text-xs text-gray-500 truncate">passthrough.dev/v/<b className="text-gray-900">{SAMPLE_VERIFICATION.code}</b></span>
        </div>
        <div className="px-4 sm:px-6 pt-5 pb-8">
          <div className="flex items-center gap-3.5">
            <span aria-hidden="true" className="w-[52px] h-[52px] rounded-full bg-green-100 border-2 border-green-600 flex items-center justify-center shrink-0">
              <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><path d="m6 13.5 4.8 4.8L20 8.6" stroke="#15803d" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            <div>
              <h3 className="text-xl font-bold text-gray-900">Passthrough Verified</h3>
              <p className="text-sm text-gray-500">Candidate: {SAMPLE_VERIFICATION.name} · {SAMPLE_VERIFICATION.field}</p>
            </div>
          </div>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 sm:gap-5 items-center my-4 p-3 sm:p-4 bg-green-50 rounded-xl border border-green-100">
            <div className="text-4xl sm:text-5xl font-extrabold leading-none text-green-700 tracking-tighter">{SAMPLE_VERIFICATION.score}<small className="text-base text-gray-500 font-semibold"> / 100</small></div>
            <div className="grid gap-1.5" aria-label="Category breakdown">
              {rows.map(([label, v]) => (
                <div key={label}>
                  <div className="flex justify-between text-[12.5px] text-gray-600 mb-0.5"><span>{label}</span><b>{v}</b></div>
                  <div className="h-[7px] bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-green-600 rounded-full" style={{ width: `${v}%` }} /></div>
                </div>
              ))}
            </div>
          </div>
          <dl className="text-[14.5px]">
            <div className="flex justify-between gap-3 py-2 border-t border-gray-100"><dt>Stored copy</dt><dd className="font-bold text-green-700">✓ Unmodified</dd></div>
            <div className="flex justify-between gap-3 py-2 border-t border-gray-100">
              <dt>The file you were sent</dt>
              <dd aria-live="polite" className={`font-bold ${exact ? 'text-green-700' : 'text-amber-800'}`}>{exact ? '✓ Exact copy' : '⚠ Not an exact copy'}</dd>
            </div>
            <div className="flex justify-between gap-3 py-2 border-t border-gray-100"><dt>Verified</dt><dd className="font-bold">Oct 2026</dd></div>
          </dl>
        </div>
      </div>
      <div className="relative bg-white rounded-b-2xl px-4 sm:px-6 pt-5 pb-5" style={{ WebkitMask: maskStub, WebkitMaskComposite: 'source-in', mask: maskStub, maskComposite: 'intersect' }}>
        <div aria-hidden="true" className="absolute left-[18px] right-[18px] top-0 border-t-2 border-dashed border-gray-300" />
        <div className="font-mono text-[11px] font-bold uppercase tracking-widest text-gray-500">File fingerprint · SHA-256</div>
        <Fingerprint hash={hash} against={issued} label="Fingerprint of the text you are holding" />
        <div aria-hidden="true" className="h-8 rounded-sm" style={{ background: 'repeating-linear-gradient(90deg,#0f172a 0 2px,transparent 2px 4px,#0f172a 4px 5px,transparent 5px 8px,#0f172a 8px 11px,transparent 11px 13px)' }} />
      </div>
    </div>
  )
}

function PlacementMock({ id }) {
  const link = `passthrough.dev/v/${SAMPLE_VERIFICATION.code}`
  const frame = 'bg-white border border-gray-200 rounded-xl px-4 py-3.5 text-sm shadow-sm'
  if (id === 'email') return (
    <div className={frame}>
      <div className="text-[12.5px] text-gray-500 border-b border-gray-100 pb-2 mb-2.5">To: Sam (Recruiting) · Subject: Product Manager application</div>
      <p className="mb-2.5">Hi Sam, I&rsquo;m applying for the Product Manager role. My resume and score are linked below.</p>
      <p><b>Alex Kimani</b> · Product Manager<br />
        <span className="inline-flex items-center gap-1.5 bg-green-50 text-green-800 border border-green-100 font-bold text-xs px-2 py-0.5 rounded-md">✓ Passthrough Verified · {SAMPLE_VERIFICATION.score}</span>{' '}
        <span className="font-mono text-[12.5px] text-blue-700 break-all">{link}</span></p>
    </div>
  )
  if (id === 'linkedin') return (
    <div className={frame}>
      <div className="text-[12.5px] text-gray-500 border-b border-gray-100 pb-2 mb-2.5">Profile · Featured</div>
      <div className="flex gap-3 items-center bg-gray-50 border border-gray-100 rounded-lg p-2.5">
        <span aria-hidden="true" className="w-[52px] h-[52px] rounded-lg bg-green-100 border border-green-200 flex items-center justify-center shrink-0">
          <svg width="24" height="24" viewBox="0 0 26 26" fill="none"><path d="m6 13.5 4.8 4.8L20 8.6" stroke="#15803d" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <div><b className="block text-sm">Verified resume · ATS score {SAMPLE_VERIFICATION.score}</b><span className="text-[12.5px] text-gray-500">passthrough.dev</span></div>
      </div>
    </div>
  )
  if (id === 'header') return (
    <div className={`${frame} text-center`}><b>Alex Kimani</b><br />Nairobi · alex@email.com<br />Verified resume: <span className="font-mono text-[12.5px] text-blue-700 break-all">{link}</span></div>
  )
  return (
    <div className={frame}>
      <label htmlFor="home-mock-site" className="block font-bold text-[13.5px] mb-1.5">Website or additional info (optional)</label>
      <input id="home-mock-site" readOnly value={link} className="w-full font-mono text-[13.5px] px-3 py-2.5 border-[1.5px] border-gray-300 rounded-lg bg-gray-50 text-gray-900" />
    </div>
  )
}

function Placements() {
  const [active, setActive] = useState(PLACEMENTS[0].id)
  const refs = useRef({})
  function onKey(e, i) {
    let next = null
    if (NAV_KEYS[e.key]) next = PLACEMENTS[(i + NAV_KEYS[e.key] + PLACEMENTS.length) % PLACEMENTS.length]
    else if (e.key === 'Home') next = PLACEMENTS[0]
    else if (e.key === 'End') next = PLACEMENTS[PLACEMENTS.length - 1]
    if (!next) return
    e.preventDefault()
    setActive(next.id)
    refs.current[next.id]?.focus()
  }
  const current = PLACEMENTS.find(p => p.id === active)
  return (
    <div>
      <div role="tablist" aria-label="Where to put your link" className="flex flex-wrap gap-1 border-b border-gray-200 mt-3.5">
        {PLACEMENTS.map((p, i) => (
          <button key={p.id} type="button" role="tab" id={`home-tab-${p.id}`} aria-selected={active === p.id} aria-controls={`home-panel-${p.id}`}
            tabIndex={active === p.id ? 0 : -1} ref={el => { refs.current[p.id] = el }} onClick={() => setActive(p.id)} onKeyDown={e => onKey(e, i)}
            className={`px-3 py-3 -mb-px text-sm font-semibold border-b-[3px] ${active === p.id ? 'text-blue-700 border-blue-700' : 'text-gray-500 border-transparent hover:text-gray-700'}`}>{p.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`home-panel-${active}`} aria-labelledby={`home-tab-${active}`} className="pt-4">
        <PlacementMock id={active} />
        <p className="mt-2.5 text-[13.5px] text-gray-500">{current.tip}</p>
      </div>
    </div>
  )
}

function CheckBox() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  function submit(e) {
    e.preventDefault()
    const code = extractVerificationCode(text)
    if (!code) { setError("That doesn't look like a Passthrough verification link or code (a code is 10 letters and digits)."); return }
    setError('')
    navigate(`/v/${encodeURIComponent(code)}`)
  }
  return (
    <div id="check" className="mt-8 bg-white rounded-xl border border-green-100 shadow-sm p-5 flex flex-wrap gap-4 items-center justify-between scroll-mt-20">
      <div>
        <h3 className="font-semibold text-gray-900">Hiring? Check a candidate&apos;s resume.</h3>
        <p className="text-sm text-gray-500">Enter a verification code or link — or <Link to="/check" className="text-blue-700 underline underline-offset-2">check the file you were sent</Link>.</p>
      </div>
      <form onSubmit={submit} className="flex gap-2 flex-1 min-w-[260px]" noValidate>
        <label className="sr-only" htmlFor="home-verify-code">Verification code or link</label>
        <input id="home-verify-code" value={text} onChange={e => setText(e.target.value)} placeholder="e.g. K7M2QX9P4A"
          aria-invalid={error ? true : undefined} aria-describedby={error ? 'home-verify-error' : undefined}
          className="flex-1 min-w-0 rounded-md border border-gray-300 px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <button type="submit" className="bg-blue-700 text-white font-semibold px-4 rounded-md hover:bg-blue-800">Check</button>
      </form>
      {error && <p id="home-verify-error" role="alert" className="w-full text-xs text-red-600">{error}</p>}
    </div>
  )
}

export default function VerifySection({ badgeThreshold }) {
  const { original, edit } = TAMPER_DEMO
  const [text, setText] = useState(original)
  const [fmt, setFmt] = useState('html')
  const embeds = useMemo(sampleEmbeds, [])
  const issued = useMemo(() => sha256Text(original), [original])
  const hash = useMemo(() => sha256Text(text), [text])
  const exact = text === original

  return (
    <section id="receipt" aria-labelledby="receipt-h" className="bg-gradient-to-b from-white to-green-50 py-[72px] scroll-mt-4">
      <div className="max-w-[1180px] mx-auto px-4 sm:px-6">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-2">Passthrough Verified</p>
          <h2 id="receipt-h" className="text-3xl font-bold text-gray-900 mb-3">Don&apos;t just claim a good resume. Show the receipt.</h2>
          <p className="text-gray-500 text-[17px]">Every Verified resume gets a link and badge employers can check in seconds: score, breakdown, and proof the file hasn&apos;t changed since. A recruiter can even check the file they were sent in their own browser, and nothing is uploaded.</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-9 items-start">
          <div className="min-w-0">
            <Ticket exact={exact} hash={hash} issued={issued} />
            <p className="mt-3.5 text-xs text-gray-500 text-center">Illustrative example of what an employer sees when they open a candidate&apos;s link.</p>
          </div>

          <div className="min-w-0 bg-white rounded-xl border border-gray-200 shadow-sm p-4 sm:p-6">
            <h3 className="text-xl font-bold text-gray-900 mb-1.5">Try the tamper test</h3>
            <p className="text-[15px] text-gray-500 mb-3.5">This is one line from the resume a recruiter was sent. Change a single character and watch the fingerprint react.</p>
            <label htmlFor="home-tamper" className="sr-only">Resume line</label>
            <textarea id="home-tamper" value={text} onChange={e => setText(e.target.value)} spellCheck={false}
              className="w-full text-base sm:text-[15px] leading-normal px-3 py-3 border-[1.5px] border-gray-300 rounded-lg resize-y min-h-[84px] text-gray-900 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" />
            <div className="flex flex-wrap gap-2.5 my-3">
              <button type="button" onClick={() => setText(original.replace(edit[0], edit[1]))} className="px-3.5 py-3 rounded-lg bg-blue-700 text-white font-semibold text-sm border border-blue-700 hover:bg-blue-800">Change one character</button>
              <button type="button" onClick={() => setText(original)} className="px-3.5 py-3 rounded-lg bg-white text-gray-800 font-semibold text-sm border border-gray-300 hover:border-gray-500">Reset</button>
            </div>
            <div><span className="font-mono text-[11px] font-bold uppercase tracking-widest text-gray-500">Fingerprint issued by Passthrough</span><Fingerprint hash={issued} label="Issued fingerprint" /></div>
            <div><span className="font-mono text-[11px] font-bold uppercase tracking-widest text-gray-500">Fingerprint of the text above</span><Fingerprint hash={hash} against={issued} label="Fingerprint of the text above" /></div>
            <div aria-live="polite" className={`mt-3.5 px-4 py-3.5 rounded-lg border-[1.5px] text-[15px] leading-snug ${exact ? 'bg-green-50 border-green-200 text-green-900' : 'bg-amber-50 border-amber-200 text-amber-900'}`}>
              <b className="block text-base mb-0.5">{exact ? 'Exact copy' : 'Not an exact copy'}</b>
              {exact ? 'This matches what Passthrough issued.' : 'This differs from what Passthrough issued. It may have been edited, re-saved or converted. Ask the candidate for the original.'}
            </div>
            <p className="mt-3.5 text-[13px] text-gray-500">The real check does this with the actual file inside the recruiter&apos;s browser, and nothing is uploaded. A mismatch doesn&apos;t prove tampering: re-saving or converting a file changes its fingerprint too. It tells the recruiter to ask for the original.</p>
          </div>
        </div>

        <div className="grid lg:grid-cols-[1.1fr_.9fr] gap-6 mt-9 items-start">
          <div>
            <h3 className="text-xl font-bold text-gray-900 mb-1">Put the receipt where recruiters already look</h3>
            <p className="text-[15px] text-gray-500">The badge comes as an SVG and a PNG, so it works in email signatures and on LinkedIn too.</p>
            <Placements />
          </div>
          <div>
            <h3 className="text-xl font-bold text-gray-900 mb-1">Grab your snippet</h3>
            <p className="text-[15px] text-gray-500">Paste it into a signature, site or README.</p>
            <div role="group" aria-label="Embed format" className="inline-flex bg-gray-100 rounded-full p-1 mt-3.5 mb-2 text-sm">
              {FORMATS.map(([k, label]) => (
                <button key={k} type="button" aria-pressed={fmt === k} onClick={() => setFmt(k)}
                  className={`px-3.5 py-2 rounded-full font-semibold ${fmt === k ? 'bg-white text-gray-900 shadow' : 'text-gray-600'}`}>{label}</button>
              ))}
            </div>
            <pre className="bg-gray-900 text-slate-200 rounded-lg p-3.5 text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap break-all" aria-label="Example embed snippet"><code>{embeds[fmt]}</code></pre>
            <div className="mt-2 flex items-center gap-3">
              <CopyButton variant="link" text={() => embeds[fmt]} resetMs={1800} label="Copy snippet" copiedLabel="Copied ✓" failedLabel="Select & copy manually" className="text-sm font-semibold bg-white border border-gray-300 rounded-lg px-3.5 py-2.5 hover:bg-gray-50" />
              <span className="text-xs text-gray-500">Yours uses your own code, after you verify.</span>
            </div>
          </div>
        </div>

        <p className="mt-7 flex gap-3.5 flex-wrap items-center text-[14.5px] text-gray-700 px-4 py-3.5 bg-white border border-gray-200 border-l-4 border-l-blue-700 rounded-lg">
          <span><b>How to earn it:</b> the Verified credential needs an ATS score of {badgeThreshold} or higher. Verified means Passthrough scored this file and it hasn&apos;t changed since. It is not an endorsement by any employer.</span>
        </p>

        <CheckBox />
      </div>
    </section>
  )
}
