import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../../lib/api'
import { buildBadgeEmbeds } from '../../lib/badgeEmbed'
import { copyToClipboard } from '../../lib/utils'
import { extractVerificationCode } from '../../lib/verificationCode'
import { SAMPLE_VERIFICATION } from '../../lib/homeContent'

const FORMATS = [['html', 'HTML'], ['markdown', 'Markdown'], ['link', 'Plain link']]

// The same snippets a real customer gets on their result page, built by the same function — shown with a
// sample code so a visitor sees exactly what they would paste into an email signature or README.
function sampleEmbeds() {
  let root = String(api.defaults.baseURL || '/api')
  try { root = new URL(root, window.location.origin).href.replace(/\/+$/, '') } catch (_) { /* keep as is */ }
  const pageUrl = `${window.location.origin}/v/${SAMPLE_VERIFICATION.code}`
  const e = buildBadgeEmbeds(root, SAMPLE_VERIFICATION.code, pageUrl)
  return { html: e.html, markdown: e.markdown, link: pageUrl }
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
    <div id="check" className="mt-8 bg-white rounded-xl border border-green-100 shadow-sm p-5 flex flex-wrap gap-4 items-center justify-between scroll-mt-4">
      <div>
        <h3 className="font-semibold text-gray-900">Hiring? Check a candidate&apos;s resume.</h3>
        <p className="text-sm text-gray-500">Enter a verification code or link — or <Link to="/check" className="text-blue-700 underline underline-offset-2">check the file you were sent</Link>.</p>
      </div>
      <form onSubmit={submit} className="flex gap-2 flex-1 min-w-[260px]" noValidate>
        <label className="sr-only" htmlFor="home-verify-code">Verification code or link</label>
        <input id="home-verify-code" value={text} onChange={e => setText(e.target.value)} placeholder="e.g. K7M2QX9P4A"
          aria-invalid={error ? true : undefined} aria-describedby={error ? 'home-verify-error' : undefined}
          className="flex-1 min-w-0 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <button type="submit" className="bg-blue-700 text-white font-semibold px-4 rounded-md hover:bg-blue-800">Check</button>
      </form>
      {error && <p id="home-verify-error" role="alert" className="w-full text-xs text-red-600">{error}</p>}
    </div>
  )
}

export default function VerifySection({ badgeThreshold }) {
  const [fmt, setFmt] = useState('html')
  const [copied, setCopied] = useState(false)
  const embeds = sampleEmbeds()

  async function copy() {
    const ok = await copyToClipboard(embeds[fmt])
    setCopied(ok ? 'Copied ✓' : 'Select & copy manually')
    setTimeout(() => setCopied(false), 1800)
  }

  const uses = [
    { icon: '✉️', title: 'In your email signature', body: 'Every message you send becomes a proof point. The PNG badge works in Gmail and Outlook.',
      extra: <div className="mt-3 border border-gray-200 rounded-lg px-3.5 py-2.5 text-xs text-gray-700 bg-white">Alex Kimani · Product Manager<br /><span className="inline-flex mt-1.5 items-center gap-1.5 bg-green-50 border border-green-100 text-green-800 font-bold rounded px-2 py-0.5">✓ Passthrough Verified · {SAMPLE_VERIFICATION.score}</span></div> },
    { icon: '🔗', title: 'On LinkedIn & your portfolio', body: 'Add it to Featured or your About section. Recruiters click it, see the score, and the page links back to you.' },
    { icon: '📎', title: 'Beside your application', body: 'Paste the link into the “website” or “additional info” field. Employers verify without a phone call.' },
  ]

  return (
    <section id="verify" className="bg-gradient-to-b from-white to-green-50 py-16">
      <div className="max-w-5xl mx-auto px-4">
        <div className="text-center max-w-2xl mx-auto mb-9">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-2">Passthrough Verified</p>
          <h2 className="text-3xl font-bold text-gray-900 mb-3">Don&apos;t just claim a good resume. Show the receipt.</h2>
          <p className="text-gray-500">Every Verified resume gets a link and badge employers can check in seconds — score, breakdown, and proof the file hasn&apos;t been edited since.</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-8 items-start">
          <div>
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 text-center">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-2.5"><span className="text-green-600 text-2xl font-bold" aria-hidden="true">✓</span></div>
              <p className="font-bold text-gray-900 text-lg">Passthrough Verified</p>
              <p className="text-sm text-gray-500">Candidate: {SAMPLE_VERIFICATION.name} · {SAMPLE_VERIFICATION.field}</p>
              <div className="grid grid-cols-3 gap-2.5 mt-4 text-left">
                <div className="bg-gray-50 rounded-lg p-2.5"><p className="text-[11px] text-gray-400">ATS score</p><p className="font-bold text-lg text-green-700">{SAMPLE_VERIFICATION.score}</p></div>
                <div className="bg-gray-50 rounded-lg p-2.5"><p className="text-[11px] text-gray-400">Integrity</p><p className="font-bold text-sm text-green-700 mt-1">Unmodified</p></div>
                <div className="bg-gray-50 rounded-lg p-2.5"><p className="text-[11px] text-gray-400">Threshold</p><p className="font-bold text-sm text-green-700 mt-1">{badgeThreshold}+ met</p></div>
              </div>
              <p className="mt-4 font-mono text-xs bg-gray-100 rounded-lg px-2.5 py-2 text-gray-700 break-all">{`${window.location.host}/v/${SAMPLE_VERIFICATION.code}`}</p>
              <p className="text-xs text-gray-500 mt-3">Illustrative example of what an employer sees when they open a candidate&apos;s link.</p>
            </div>

            <div className="mt-4">
              <div role="group" aria-label="Embed format" className="inline-flex bg-gray-100 rounded-full p-1 mb-2 text-sm">
                {FORMATS.map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={fmt === k} onClick={() => setFmt(k)}
                    className={`px-3.5 py-1 rounded-full font-semibold ${fmt === k ? 'bg-white text-gray-900 shadow' : 'text-gray-600'}`}>{label}</button>
                ))}
              </div>
              <pre className="bg-gray-900 text-slate-200 rounded-lg p-3.5 text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap break-all" aria-label="Example embed snippet"><code>{embeds[fmt]}</code></pre>
              <div className="mt-2 flex items-center gap-3">
                <button type="button" onClick={copy} className="text-sm font-semibold bg-white border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50">{copied || 'Copy snippet'}</button>
                <span className="text-xs text-gray-500">Yours uses your own code, after you verify.</span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3.5">
            {uses.map(u => (
              <div key={u.title} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex gap-3.5">
                <div aria-hidden="true" className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-lg shrink-0">{u.icon}</div>
                <div className="min-w-0"><h3 className="font-semibold text-gray-900 text-[15px]">{u.title}</h3><p className="text-sm text-gray-500">{u.body}</p>{u.extra}</div>
              </div>
            ))}
          </div>
        </div>

        <CheckBox />
      </div>
    </section>
  )
}
