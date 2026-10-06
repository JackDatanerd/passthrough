// lib/ai/guardian-email.ts
//
// Pure helpers for the Guardian inbound-email webhook (no aliased imports, so they
// are unit-testable in isolation — see tests/guardian-email.test.ts).
//
// FIX (independent pass, section 13): extractUnquotedContent used to be a per-line
// filter. It removed the "-----Original Message-----" marker line and "From:"/"Sent:"
// lines but left the ENTIRE quoted body of an Outlook-style reply in place (so an old,
// already-handled scope request was re-classified as new), never matched Gmail's
// attribution line when the mail client wrapped it over two lines ("On … <a@b.com>" /
// "wrote:"), and deleted any legitimate line that merely began with "From:" or "---".
// Replies are now CUT at the first reply marker instead of filtered line-by-line.
//
// The one wrinkle: the documented workflow is to FORWARD a client's email to the
// project's Guardian address, and a forward's quoted content IS the client request.
// A forward is recognised from the subject (Fwd:/FW:) or a forwarded-message banner, and
// in that case the forwarded body is kept (only its header block is dropped).

// Relative (not '@/') so this file stays loadable without the Next alias; sanitize.ts is the shared Postgres-safe text helper.
import { stripUnstorableText, truncateText } from '../utils/sanitize'

// FIX (independent pass round 4, section 13): this used to test only the single prefix at the very
// start of the subject, while cleanSubject() below strips a whole CHAIN of them in a loop. A subject
// with a reply prefix layered in front of a forward marker — "Re: Fwd: New feature idea" (reply-all
// on a forward, or a client replying into a thread that was itself forwarded in) — never matched here,
// even though it plainly IS a forward. Downstream, extractUnquotedContent only keeps a forward's body
// when isForward is true or a "Forwarded message" banner is seen in the text; Outlook's classic forward
// format has neither (no banner, just a bare header block) if the subject check misses it — so the
// entire forwarded client request was silently cut as "quoted reply" with nothing left to classify.
// Walk the same chain cleanSubject() strips, and call it a forward the moment ANY layer is one.
const PREFIX_CHAIN    = /^\s*(re|fwd?|fw|wg|tr|rv|aw)\s*:\s*/i
const FORWARD_TOKENS  = new Set(['fwd', 'fw', 'wg', 'tr', 'rv'])
const FORWARD_BANNER  = /^[-–—_\s]*(begin forwarded message|forwarded message)[-–—_:\s]*$/i
const ORIGINAL_MSG    = /^[-–—_\s]*original message[-–—_\s]*$/i
const OUTLOOK_RULE    = /^_{20,}\s*$/
const ON_WROTE_ONE    = /^on\s.{5,300}\swrote:\s*$/i
const ON_WROTE_START  = /^on\s.{5,300}$/i
const WROTE_ONLY      = /^wrote:\s*$/i
const SIGNATURE_DELIM = /^--\s?$/
// FIX (Guardian section 13, pass 14 - B5): reply headers / attributions only existed in English, so an Outlook or Apple Mail reply
// in German / French / Spanish / Italian / Portuguese was never cut and the whole quoted thread was classified as a new request.
const I18N_FROM = /^(from|von|de|da|van|fr[åa]n|fra)\s*:/i
const I18N_SENT = /^(sent|date|gesendet|datum|envoy[ée]|date d['’]envoi|enviado(?: el)?|enviada|fecha|inviato|data)\s*:/i
const I18N_HEADER = /^(from|sent|date|to|cc|bcc|subject|reply-to|von|gesendet|an|betreff|datum|de|[àa]|objet|envoy[ée]|para|asunto|enviado(?: el)?|fecha|da|inviato|oggetto|a|assunto|enviada|data)\s*:/i
// FIX (Guardian section 13, pass 16 - B-A): the one/two-letter localized header words (a, an, de, da, data, para) are also ordinary
// line starts in a client's request ("A: add a store", "De: nada, solo un blog"), and skipHeaderBlock swallowed them as headers. Those
// ambiguous words now only count as header lines when the value carries an address (a real To:/A:/An: line lists recipients).
const WEAK_HEADER = /^(an|de|[àa]|para|da|a|data)\s*:/i
function isHeaderLine(v: string): boolean {
  if (!I18N_HEADER.test(v)) return false
  if (WEAK_HEADER.test(v)) return /[@<]/.test(v)
  return true
}
const ON_WROTE_I18N = /^(am|le|el|il|em|op|den)\s.{5,300}\b(schrieb|a [ée]crit|escribi[óo]|ha scritto|escreveu|schreef|skrev)(?=[\s:]).{0,200}:\s*$/i

export function isForwardSubject(subject: string): boolean {
  let s = String(subject || '')
  // Bounded iteration count — a real subject has at most a handful of chained prefixes; this just
  // guards against a pathological input, not normal mail.
  for (let i = 0; i < 12; i++) {
    const m = s.match(PREFIX_CHAIN)
    if (!m) return false
    if (FORWARD_TOKENS.has(m[1].toLowerCase())) return true
    s = s.slice(m[0].length)
  }
  return false
}

/** Strip a leading Re:/Fwd: chain from a subject for display/classification. */
export function cleanSubject(subject: string): string {
  return truncateText(stripUnstorableText(String(subject || '').replace(/^\s*((re|fwd?|fw|wg|tr|rv|aw)\s*:\s*)+/i, '').trim()), 300)
}

// FIX (independent pass 4, section 13 - B3): a wrapped attribution ("On <something>" / "<name> wrote:") was recognised
// from the two line SHAPES alone, so an ordinary request - "On the homepage we need a banner" followed by a line that
// happens to end in "wrote:" - was cut as a quoted reply and the real request vanished. A genuine attribution carries a
// date, a time or an address ("On Mon, Sep 1, 2026 at 10:00 AM Bob <bob@x.com>"); require one of those on the first line.
const ATTRIBUTION_HINT = /[\d@]/

export function extractUnquotedContent(text: string, opts: { isForward?: boolean } = {}): string {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let forwarded = !!opts.isForward

  // FIX (independent pass 4, section 13 - B2): every line starting with ">" was dropped, forwards included. Several
  // clients (Apple Mail, Thunderbird, some Outlook settings) deliver a forwarded message's body ">"-quoted - and the
  // documented workflow is to FORWARD the client's email to the project address - so the whole client request was
  // discarded and only the forwarder's cover note was classified (a forward with nothing but quoted lines became
  // empty). In a forward, ONE quote level is removed and the text is kept; anything still quoted after that (the
  // earlier thread inside the forwarded mail) is dropped exactly as before. Replies are unchanged.
  const view = (line: string): string => {
    const t = line.trim()
    return forwarded && t.startsWith('>') ? t.replace(/^>\s?/, '').trim() : t
  }

  // FIX (independent pass 5, section 13 - B1): the "-- " signature delimiter ended the scan unconditionally. In a
  // forward the forwarder's OWN signature sits ABOVE the forwarded message in Outlook / Apple Mail / Thunderbird
  // ("FYI see below", "--", "Bob / Acme", then the forwarded header block or banner), so the scan stopped before it
  // ever reached the client's request and only the cover note was classified (-> in_scope, no flag, no failure marker).
  // Until the forwarded body has started, a delimiter now looks ahead for where it starts and resumes there; with
  // nothing to resume at it ends the scan exactly as before. Once the forwarded body is under way a delimiter is the
  // CLIENT's signature and still ends it (everything below is the earlier thread).
  let inForwardedBody = false
  const FORWARD_LOOKAHEAD = 60 // a signature block is a handful of lines; never scan the whole message for this
  const forwardedBodyStart = (from: number): number => {
    const stop = Math.min(lines.length, from + FORWARD_LOOKAHEAD)
    for (let j = from; j < stop; j++) {
      const lt = lines[j].trim()
      if (FORWARD_BANNER.test(lt)) return j
      if (forwarded && (ORIGINAL_MSG.test(view(lines[j])) || OUTLOOK_RULE.test(view(lines[j])) || isHeaderPair(lines, j, view) || lt.startsWith('>'))) return j
    }
    return -1
  }

  let i = 0
  for (; i < lines.length; i++) {
    const raw = lines[i]
    const quoted = raw.trim().startsWith('>')
    if (quoted && !forwarded) continue
    const t = view(raw)
    if (quoted && t.startsWith('>')) continue // a deeper quote level inside a forward: earlier thread
    const body = quoted ? t : raw

    if (SIGNATURE_DELIM.test(body.trimEnd())) {
      // FIX (Guardian section 13, pass 14 - B5): a bare "--" (no trailing space - many clients and Postmark's text conversion strip it)
      // ended the scan too, so "Add dark mode.\n--\nAlso add Spanish." lost the second request. The real delimiter is "-- " and always
      // ends the scan; a bare "--" only does when what follows is signature-sized, otherwise it is just a separator line.
      const strict = /^--\s$/.test(body)
      if (!strict) {
        let rest = 0, first = ''
        for (let k = i + 1; k < lines.length && rest <= 12; k++) if (lines[k].trim()) { if (!rest) first = lines[k].trim(); rest++ }
        // A signature's first line is a name / sign-off, not a sentence: a line ending in . ! ? is more request text.
        // FIX (Guardian section 13, pass 16 - B-B): a second request with no terminal punctuation ("Also add a Spanish version") was
        // still read as a signature and dropped. Losing a signature costs nothing; losing a request is the failure Guardian exists to
        // prevent, so only a short name-like line, a sign-off, or a contact line (address / phone / pipe) ends the scan.
        const signoff = /^(thanks|thank you|regards|kind regards|best|best regards|cheers|sincerely|warm regards|sent from|get outlook)\b/i.test(first)
        const contactLike = /[@|]|\d{5,}/.test(first)
        const nameLike = first.split(/\s+/).length <= 4 && !/[.!?]$/.test(first)
        if (!signoff && (rest > 12 || /[.!?]$/.test(first) || !(contactLike || nameLike))) continue
      }
      if (!inForwardedBody) {
        const start = forwardedBodyStart(i + 1)
        if (start !== -1) { i = start - 1; continue } // the loop's i++ lands on the forwarded block
      }
      break
    }

    // Gmail / Apple Mail attribution, possibly wrapped onto the next line.
    const next = view(lines[i + 1] || '')
    // FIX (Guardian section 13, pass 15 - B1): this single-line form was the only attribution rule without the date/address
    // hint, so ordinary prose such as "On the kickoff call Sarah wrote:" cut the scan there and everything after it - the
    // client's actual new request - was dropped (classified as just the greeting -> in_scope, no flag).
    // A genuine attribution carries a date/address, or (abbreviated forms like "On Sun, Jane wrote:") is followed by the
    // quoted text itself, so a hint-less line only cuts when the next line is ">"-quoted.
    if (ON_WROTE_ONE.test(t) && (ATTRIBUTION_HINT.test(t) || (lines[i + 1] || '').trim().startsWith('>'))) break
    if (ON_WROTE_I18N.test(t) && ATTRIBUTION_HINT.test(t)) break
    if (ON_WROTE_START.test(t) && ATTRIBUTION_HINT.test(t) && !t.endsWith('wrote:') && WROTE_ONLY.test(next)) break
    if (ON_WROTE_START.test(t) && ATTRIBUTION_HINT.test(t) && /wrote:\s*$/i.test(next) && next.length < 120) break

    if (FORWARD_BANNER.test(t)) { forwarded = true; inForwardedBody = true; skipHeaderBlock(); continue }

    const startsOutlook = ORIGINAL_MSG.test(t) || OUTLOOK_RULE.test(t) || isHeaderPair(lines, i, view)
    if (startsOutlook) {
      if (!forwarded) break            // reply: everything below is the quoted thread
      inForwardedBody = true
      skipHeaderBlock(); continue       // forward: keep the forwarded body, drop its headers
    }

    if (quoted && forwarded) inForwardedBody = true // a ">"-quoted forwarded body has begun
    out.push(body)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  // Advance past the run of header lines (From:/Sent:/To:/Subject: …) + blank lines that follows.
  function skipHeaderBlock() {
    while (i + 1 < lines.length && (isHeaderLine(view(lines[i + 1])) || view(lines[i + 1]) === '')) i++
  }
}

// A "From: x" line immediately followed (within 3 lines) by "Sent:"/"Date:" is an
// Outlook-style quoted header block; a lone "From:" line in prose is not.
function isHeaderPair(lines: string[], i: number, view: (l: string) => string): boolean {
  const from = view(lines[i])
  if (!I18N_FROM.test(from)) return false
  // FIX (Guardian section 13, pass 16 - B-C): "From: the design team we want more" + "Date: Monday is the deadline" in a client's prose
  // was cut as an Outlook header block. A real block's date line carries a year or a clock time (or at least a digit when the From
  // line carries an address); prose rarely does.
  // A From: line with an address ("Name <a@b.com>") plus a Sent:/Date: line is accepted as before.
  const hasAddr = /[@<]/.test(from)
  for (let k = 1; k <= 3; k++) {
    const d = view(lines[i + k] || '')
    if (I18N_SENT.test(d) && (hasAddr || /\d{4}|\d{1,2}[:h]\d{2}/.test(d))) return true
  }
  return false
}

// ── Auto-responders / bounces ─────────────────────────────────
export function isAutomatedMessage(payload: any): boolean {
  const headers: Array<{ Name?: string; Value?: string }> = Array.isArray(payload?.Headers) ? payload.Headers : []
  const get = (n: string) => headers.find(h => (h.Name || '').toLowerCase() === n)?.Value?.trim().toLowerCase()
  const autoSubmitted = get('auto-submitted')
  if (autoSubmitted && autoSubmitted !== 'no') return true
  if (get('x-autoreply') || get('x-autorespond') || get('x-failed-recipients')) return true
  const precedence = get('precedence')
  if (precedence && ['bulk', 'junk', 'auto_reply', 'auto-reply', 'list'].includes(precedence)) return true
  const from = String(payload?.FromFull?.Email || payload?.From || '').toLowerCase()
  if (/(^|<)(mailer-daemon|postmaster)@/.test(from)) return true
  return false
}

export function senderEmail(payload: any): string {
  const full = payload?.FromFull?.Email
  if (typeof full === 'string' && full.includes('@')) return full.trim().toLowerCase()
  const m = String(payload?.From || '').match(/<([^>]+)>/)
  return (m ? m[1] : String(payload?.From || '')).trim().toLowerCase()
}

/** Match `proj-<prefix>@<domain>` as the WHOLE address (not a suffix of another address). */
export function matchGuardianAddress(header: string, domain: string): string | null {
  const esc = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // FIX (Guardian section 13, pass 14 - B5): a plus-tagged recipient (proj-ab12cd34+anything@...) is the same mailbox and is
  // delivered to it by most providers/forwarding rules; it used to not match and the email was dropped as "not a Guardian address".
  const m = String(header || '').match(new RegExp(`(?<![a-z0-9._%+-])proj-([a-z0-9]+)(?:\\+[a-z0-9._-]*)?@${esc}(?![a-z0-9.-])`, 'i'))
  return m ? m[1].toLowerCase() : null
}
