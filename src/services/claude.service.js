// Identical logic to v8. Only change: Workers have no `process.env`, so every
// function takes `env` (the Worker's bindings object) as its first parameter
// instead of reading ANTHROPIC_API_KEY/ANTHROPIC_MODEL from a global.

function model(env) {
  return env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
}

// HARDENING: callClaude is the single gateway every AI call in the app goes
// through (scoring, structuring, rewriting, HTML generation) — and until
// this fix it had no timeout at all. That's not just slow-response
// annoyance: createScan's runAtsScan runs via ctx.waitUntil(), which has a
// hard, UNCATCHABLE 30-second wall-clock cap — the platform kills the task
// mid-flight with no exception, not even reaching this function's own catch
// block. A Claude response that merely took ~25-30s (rate-limit backpressure,
// a slow day on Anthropic's end, no error at all) would silently leave the
// scan stuck at status='SCANNING' with zero log output, recovered only by
// the hourly cron's 30-minute-stuck-scan sweep (index.js's scheduled()).
// Queue-consumer jobs (generateFix/generateBadge) aren't capped by
// waitUntil's 30s wall clock, but CPU-time limits don't count time spent
// waiting on a fetch either — so without this, a genuinely hung upstream
// request could stall a queue job indefinitely instead of failing fast into
// the existing retry/DLQ handling.
//
// 20s chosen to sit comfortably under the 30s waitUntil cap (leaving margin
// for the rest of runAtsScan's own work after this returns) while still
// being generous for a normal Claude response.
const CLAUDE_TIMEOUT_MS = 20000

async function callClaude(env, system, userMsg, maxTokens) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':          env.ANTHROPIC_API_KEY,
        'anthropic-version':  '2023-06-01',
        'Content-Type':       'application/json'
      },
      body: JSON.stringify({
        model:    model(env),
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userMsg }]
      }),
      signal: controller.signal
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error?.message || 'Claude API error')
    // stop_reason 'max_tokens' means the response was cut off mid-output —
    // if that happens on a JSON-generating call, JSON.parse will fail on
    // truncated output, and the real cause (maxTokens too low for this
    // input) would otherwise be indistinguishable from a genuine malformed
    // response. Surface it so callers/logs can tell the difference.
    return { success: true, data: json.content[0].text, error: null, stopReason: json.stop_reason }
  } catch (err) {
    // AbortError from our own timeout gets a clearer message than the raw
    // "The operation was aborted" — callers/logs shouldn't have to guess
    // whether this was a timeout or something else.
    const message = err.name === 'AbortError'
      ? `Claude API call timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`
      : err.message
    console.error('Claude error:', message)
    return { success: false, data: null, error: message, stopReason: null }
  } finally {
    clearTimeout(timeout)
  }
}

// Claude frequently wraps JSON output in markdown code fences (```json ... ```)
// or adds a stray leading/trailing sentence despite explicit "ONLY valid JSON"
// instructions. Strip that defensively before parsing rather than letting a
// well-formatted-but-fenced response get discarded as a hard parse failure.
//
// BUG FIX (audit): this used to search for a ``` fence unconditionally and
// take the FIRST pair it found, via a lazy [\s\S]*? match. The prompts all
// ask for raw JSON (see "Return ONLY valid JSON" below) — a normal response
// has no fence at all — but resume/JD content routinely contains its own
// literal ``` sequences (a bullet quoting a markdown code block, e.g.
// "Documented API usage with ```curl``` examples"), and the old regex would
// mistake that embedded pair for the wrapper, truncate `s` to whatever sat
// between them, and hand JSON.parse a garbage fragment — discarding an
// entirely valid, successfully-generated response as a PARSE_FAIL on every
// Claude call site in the app (scoring, structuring, and the paid rewrite).
// Fixed two ways: (1) try a direct parse first, which is what a normal
// unfenced response needs and makes it immune to embedded backticks
// entirely; (2) only if that fails, fall back to a fence match — now greedy
// ([\s\S]* not [\s\S]*?) so it captures up to the LAST ``` in the response
// rather than the first, correctly spanning an embedded backtick pair
// inside the real fenced JSON instead of stopping at it.
function extractJson(raw) {
  if (typeof raw !== 'string') throw new Error('Claude response was not a string')
  const s = raw.trim()
  try {
    return JSON.parse(s)
  } catch (_) {
    const fenced = s.match(/```(?:json)?\s*([\s\S]*)```/i)
    if (fenced) return JSON.parse(fenced[1].trim())
    throw new Error('Could not parse Claude response as JSON')
  }
}

// Parses `result.data` as JSON with fence-stripping, and on failure logs
// enough context (label, stop_reason, a truncated snippet of the raw output)
// to diagnose the cause from wrangler tail without needing to reproduce —
// distinguishes "Claude got cut off before finishing the JSON" (raise
// maxTokens) from "Claude returned genuinely malformed JSON" (prompt issue).
function parseJsonResult(result, label) {
  if (!result.success) return result
  try {
    return { success: true, data: extractJson(result.data), error: null }
  } catch (parseErr) {
    const truncated = result.stopReason === 'max_tokens'
    console.error(
      `${label} JSON parse failed${truncated ? ' (response was TRUNCATED — maxTokens too low for this input)' : ''}:`,
      parseErr.message,
      '| raw (first 500 chars):', (result.data || '').slice(0, 500)
    )
    return {
      success: false,
      data: null,
      error: truncated ? 'RESPONSE_TRUNCATED' : 'PARSE_FAIL'
    }
  }
}

async function scoreResumeWithAI(env, resumeText, jdText) {
  return callClaude(
    env,
    'ATS expert. Return ONLY valid JSON.',
    `Resume:\n${resumeText}\n\nJD:\n${jdText}\nReturn: {"aiScore":number,"missingKeywords":[]}`,
    800
  )
}

// SCHEMA NOTE (section audit — "generate a resume from scratch"): linkedin/
// portfolio and projects were previously entirely absent from this schema —
// not just unpopulated, structurally impossible to capture, since nothing
// downstream (serializeResumeData, docx.service.js, this very prompt) had
// anywhere to put them even if a resume/brain-dump plainly stated them.
// ats.service.js's scoreSections already anticipated a header with
// "LinkedIn/portfolio/GitHub each on their own line" in its own comments —
// this closes that gap rather than opening a new one. rewriteResumeContent
// below is intentionally left schema-agnostic ("same schema as the input
// resume") so these fields survive a paid rewrite unchanged in shape.
async function parseResumeStructure(env, rawText) {
  const result = await callClaude(
    env,
    'Extract resume data. Return ONLY valid JSON.',
    `Extract from:\n${rawText}\nReturn: {"name":"","email":"","phone":null,"location":null,"linkedin":null,"portfolio":null,"summary":null,` +
    `"experience":[{"company":"","title":"","dates":"","bullets":[]}],` +
    `"education":[{"institution":"","degree":"","dates":""}],"skills":[],"certifications":[],` +
    `"projects":[{"name":"","description":"","technologies":[],"link":null}]}`,
    2000
  )
  return parseJsonResult(result, 'parseResumeStructure')
}

// Structuring pass for the brain-dump entry path (Phase 1). Distinct from
// parseResumeStructure above: that function expects input that already
// looks like a resume (extracted from an uploaded PDF/DOCX) and is mostly
// doing format normalization. This function expects genuinely messy input —
// stream-of-consciousness paragraphs, a pasted old resume with broken
// formatting, half-sentences, whatever the user typed into a brain-dump box.
//
// Same output schema as parseResumeStructure (so callers downstream — the
// diff view, generateFix, generateBadge — never need to know which entry
// path produced the data). The system prompt is the only real difference:
// explicit permission to work from loose, conversational, incomplete text,
// combined with the same non-negotiable conservatism the rest of the app
// requires — leave a field null/empty rather than guess a company name,
// date, or title that isn't clearly stated.
async function structureFreeformText(env, rawText) {
  const result = await callClaude(
    env,
    `Career counselor structuring a messy, informal work history into resume
     data. The input may be stream-of-consciousness, incomplete sentences,
     a pasted old resume with broken formatting, or a mix of all three.
     Extract only what is clearly stated. If a company name, job title,
     date, or institution is ambiguous or not clearly stated, use null or
     omit it — NEVER guess or invent a plausible-sounding value to fill a
     gap. Convert loose descriptions of work into resume-style bullet
     points, but every bullet must be traceable to something the user
     actually described — do not add responsibilities, scope, or outcomes
     the user did not mention. The same conservatism applies to projects
     and links: only capture a project if the user actually describes
     something they built/contributed to (a class project, a side build, an
     open-source contribution — not just a technology they know), and only
     capture a LinkedIn/portfolio/GitHub URL if one is literally present in
     the text — never construct or guess one from a name or company. Return
     ONLY valid JSON.`,
    `Structure this into resume data:\n${rawText}\nReturn: {"name":"","email":"","phone":null,"location":null,"linkedin":null,"portfolio":null,"summary":null,` +
    `"experience":[{"company":"","title":"","dates":"","bullets":[]}],` +
    `"education":[{"institution":"","degree":"","dates":""}],"skills":[],"certifications":[],` +
    `"projects":[{"name":"","description":"","technologies":[],"link":null}]}`,
    2500
  )
  return parseJsonResult(result, 'structureFreeformText')
}

async function rewriteResumeContent(env, resumeData, jdText, scoreFeedback = null) {
  // AUDIT FIX: this always assumed a numeric `score` (a real prior attempt
  // that got all the way to scoring) — scan.controller.js's generateFix now
  // also feeds this a fabrication-retry signal with `score: null`, which
  // used to read as the nonsensical "scored null/100". Branching on
  // whether a real score is present keeps that message sensible either way.
  const feedbackBlock = scoreFeedback
    ? (typeof scoreFeedback.score === 'number'
        ? `\n\nIMPORTANT — this is a retry. The previous attempt scored ${scoreFeedback.score}/100 and fell short of the ${scoreFeedback.threshold} target. Specifically weak areas: ${scoreFeedback.weakAreas.join('; ')}. Address these directly in this revision — don't just lightly rephrase, meaningfully strengthen the specific weak areas called out.`
        : `\n\nIMPORTANT — this is a retry. The previous attempt was rejected before scoring: ${scoreFeedback.weakAreas.join('; ')}. Fix this directly in this revision.`)
    : ''
  const result = await callClaude(
    env,
    `ATS resume writer. Incorporate JD keywords naturally.
     NEVER fabricate employers, institutions, credentials, or dates not in input.
     NEVER invent a number, percentage, or metric the user did not provide —
     if a bullet describes an outcome or improvement that would be stronger
     with a number and none was given, leave the bullet as an honest
     qualitative statement and instead flag it in quantificationOpportunities.
     Optimize for US and UK employer expectations. Use standard US resume conventions — avoid regional formatting, idioms, or terminology that may be unfamiliar to North American or European hiring managers.
     Return ONLY valid JSON with this exact shape:
     {"resume": <the resume object, same schema as the input resume>,
      "quantificationOpportunities": [{"bullet": "the exact rewritten bullet text", "suggestion": "brief guidance on what number or metric would strengthen it"}]}`,
    `Resume:\n${JSON.stringify(resumeData)}\n\nJD:\n${jdText}${feedbackBlock}\nReturn the JSON envelope described above — "resume" must follow the exact same schema as the input resume object.`,
    4500
  )
  if (!result.success) return result
  // CRITICAL: result.data is a raw string — must parse before use as object
  let envelope
  try {
    envelope = extractJson(result.data)
  } catch (parseErr) {
    const truncated = result.stopReason === 'max_tokens'
    console.error(
      `rewriteResumeContent JSON parse failed${truncated ? ' (response was TRUNCATED — maxTokens too low for this input)' : ''}:`,
      parseErr.message,
      '| raw (first 500 chars):', (result.data || '').slice(0, 500)
    )
    return { success: false, data: null, error: truncated ? 'RESPONSE_TRUNCATED' : 'PARSE_FAIL' }
  }

  const rewritten = envelope?.resume
  if (!rewritten || typeof rewritten !== 'object')
    return { success: false, data: null, error: 'PARSE_FAIL' }
  if (detectFabrication(resumeData, rewritten))
    return { success: false, data: null, error: 'FABRICATION_DETECTED' }

  // Defensive filter — malformed entries from the model (missing/wrong-typed
  // fields) are dropped rather than allowed to crash the frontend list render.
  const quantificationOpportunities = Array.isArray(envelope.quantificationOpportunities)
    ? envelope.quantificationOpportunities.filter(
        q => q && typeof q.bullet === 'string' && typeof q.suggestion === 'string'
      )
    : []

  return { success: true, data: rewritten, quantificationOpportunities, error: null }
}

function detectFabrication(orig, rewritten) {
  const norm = s => (s || '').toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|university|institute|college|group)\b/g, '')
    .replace(/[.,]/g, '').trim()
  // AUDIT FIX (section audit — "generate a resume from scratch"): projects
  // are new to this schema (see parseResumeStructure/structureFreeformText
  // above) and just as fabricatable as an employer or institution — a
  // rewrite that invents a project the user never mentioned is the same
  // class of trust violation this function already exists to catch for
  // companies/schools. Folded into the same origAll/newAll comparison
  // rather than a separate check, so one violation of either kind trips
  // the same FABRICATION_DETECTED path in rewriteResumeContent below.
  const origAll = [
    ...(orig.experience || []).map(e => norm(e.company)),
    ...(orig.education  || []).map(e => norm(e.institution)),
    ...(orig.projects   || []).map(p => norm(p.name))
  ].filter(Boolean)
  const newAll = [
    ...(rewritten.experience || []).map(e => norm(e.company)),
    ...(rewritten.education  || []).map(e => norm(e.institution)),
    ...(rewritten.projects   || []).map(p => norm(p.name))
  ].filter(Boolean)
  // BUG FIX (audit): only the o.includes(n) direction is safe here — it
  // catches a rewrite that shortens a real name (e.g. "Cape Town
  // University" -> "Cape Town"), which is the one legitimate case
  // normalization alone (corporate-suffix stripping, above) doesn't already
  // handle. The other direction, n.includes(o), was also being accepted:
  // it means the NEW name contains the ORIGINAL as a substring, i.e. the
  // rewrite EXTENDED a real name with extra words ("IBM" -> "IBM Watson
  // Research"). That's exactly the shape of fabrication this function
  // exists to catch — padding a real anchor with invented detail — so
  // accepting it was a bypass, not a feature. No legitimate rewrite needs
  // to add words to an employer/institution/project name it was given.
  for (const n of newAll)
    if (!origAll.some(o => o.includes(n))) return true

  // BUG FIX (Scan/ATS section audit, round 2): this function only ever
  // checked the ADDED direction above — every `n` in the rewrite had to
  // trace back to something real — but never checked the reverse: whether
  // an entry from the ORIGINAL simply vanished from the rewrite. That's not
  // a hypothetical gap — the retry-feedback text this function's own
  // caller sends back to Claude on a catch (see generateFix in
  // scan.controller.js) explicitly claims both directions are guarded:
  // "included a company, title, or institution not present in the original
  // resume, or dropped one that was". Only the first half was ever true.
  // A rewrite that silently drops an entire job, degree, or project is a
  // real integrity problem for a document someone is about to send to
  // employers — arguably worse than an addition, since it UNDERSTATES a
  // candidate's real history — and it went completely unguarded: no
  // FABRICATION_DETECTED, no retry, nothing. DiffView.jsx's positional/
  // name matching can SHOW a drop after the fact if the user happens to
  // look, but that's a passive display, not a gate on what gets delivered.
  // Symmetric with the loop above: every `o` in the original must trace
  // forward to something in the rewrite (o.includes(n) — a real name is
  // allowed to be quoted more briefly, e.g. "Cape Town University" ->
  // "Cape Town" still matches here since some `n` will still equal/contain
  // "cape town").
  for (const o of origAll)
    if (!newAll.some(n => o.includes(n))) return true

  return false
}

async function generateBeautifulResumeHTML(env, resumeData, designTokens, verificationUrl, { verified = true } = {}) {
  const { palette, fonts } = designTokens
  // SECTION 7 AUDIT: only claim "Verified" (with the ✓) when the score actually
  // cleared the threshold — see generateFix in scan.controller.js.
  const credentialText = verified ? '✓ Passthrough Verified' : 'Passthrough Scan Report'
  const verificationInstruction = verificationUrl
    ? `Header line 3 MUST be: <a href="${verificationUrl}" style="text-decoration:none">
       <span style="color:${palette.primary};font-size:8pt;font-variant:small-caps">${credentialText}</span>
     </a> — URL hidden, only "${credentialText}" visible as clickable link.`
    : `Do NOT include any "Passthrough Verified" credential line, badge, or link anywhere — this resume has no verification credential attached. Header is just name + contact info.`
  const result = await callClaude(
    env,
    'Senior UI designer. Generate complete self-contained HTML resume. Raw HTML only, no markdown.',
    `CANDIDATE: ${JSON.stringify(resumeData)}
     Colors: bg=${palette.bg} primary=${palette.primary} accent=${palette.accent} text=${palette.text}
     Fonts: heading=${fonts.heading} body=${fonts.body} hPt=${fonts.hPt} bPt=${fonts.bPt}
     ${verificationInstruction}
     If CANDIDATE.linkedin or CANDIDATE.portfolio is present, include it in the
     header contact line alongside email/phone/location. If CANDIDATE.projects
     is a non-empty array, include a PROJECTS section (name, technologies,
     description, and a link if present) — position it after Experience,
     before Education, unless the candidate has little/no Experience, in
     which case place Projects before Experience since it's likely the
     stronger section for this candidate.
     Single column, left spine 4px solid ${palette.primary}, A4 size, @import fonts from Google.
     -webkit-print-color-adjust:exact. No JavaScript. No fabrication.
     OUTPUT: Raw HTML starting with <!DOCTYPE html>`,
    4000
  )
  if (!result.success) return result
  if (!result.data?.trimStart().startsWith('<!DOCTYPE') && !result.data?.trimStart().startsWith('<html'))
    return { success: false, data: null, error: 'INVALID_HTML' }
  return { success: true, data: sanitizeGeneratedHtml(result.data), error: null }
}

// Sanitization for AI-generated HTML that gets rendered in a real browser
// (pdf.service.js's Cloudflare Browser Rendering session). Two independent
// concerns are handled here:
//
//   1. Script execution — JS is disabled on the Puppeteer page itself
//      (the primary defense), this is belt-and-suspenders in case that
//      ever regresses: strips <script> tags, on*="..."/on*='...' event
//      handlers, and javascript:/data: URIs in href/src.
//
//   2. SSRF / remote-resource loading — disabling JS does NOT stop plain
//      markup from triggering a network request: <img src>, <link href>
//      (stylesheets), <iframe>/<object>/<embed> src, CSS url()/@import,
//      and <meta http-equiv="refresh"> can all fire a fetch or navigation
//      with zero JavaScript involved. resumeData here ultimately derives
//      from user-supplied resume/brain-dump text that passed through an
//      earlier Claude structuring call — a successful prompt injection in
//      that text could in principle get this generation call to emit a
//      tag pointing at an internal address or an attacker-controlled
//      endpoint, and Browser Rendering would actually fetch it. HARDENING:
//      resource-loading tags with no legitimate use in a static resume
//      layout (<img>, <iframe>, <object>, <embed>, <frame>, <video>,
//      <audio>, <source>, <track>, <base>, meta-refresh) are stripped
//      outright. <link>/CSS url()/@import are NOT stripped outright
//      because the prompt legitimately asks for Google Fonts — those are
//      allowlisted to fonts.googleapis.com/fonts.gstatic.com and every
//      other target is neutralized.
const ALLOWED_RESOURCE_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']

function isAllowedResourceUrl(url) {
  try {
    const u = new URL(url, 'https://invalid.example/')
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    return ALLOWED_RESOURCE_HOSTS.includes(u.hostname.toLowerCase())
  } catch (_) {
    return false
  }
}

// BUG FIX (audit): four narrow regex-bypass shapes hardened, all in the same
// "belt and suspenders" spirit as the rest of this function (JS execution is
// already disabled at the Puppeteer layer, but the img/link/url() paths
// below don't depend on JS execution at all, so this sanitizer is the only
// thing standing between an SSRF attempt and Browser Rendering fetching it):
//   1. An unclosed <script> (no matching </script>, e.g. a truncated
//      generation) previously survived entirely — the lazy [\s\S]*?<\/script>
//      match requires a closing tag to match at all. Added a second pass
//      that strips any <script ...> with nothing left to pair it with,
//      through to the end of the document.
//   2. on\w+= handlers required a preceding whitespace character to match —
//      `<div/onclick="...">` (a slash instead of a space, valid/tolerated
//      HTML) slipped through untouched. Broadened to [\s/] on all three
//      quoting variants.
//   3. javascript:/data: URIs required the scheme immediately after the
//      opening quote — `href=" javascript:..."` (leading whitespace, which
//      browsers strip when resolving the scheme) bypassed the check.
//      Allowed optional whitespace before the scheme.
// (The fourth — <link>'s unquoted-href handling — is fixed separately below,
// next to that block, since it's a false-positive-removal bug rather than a
// bypass.)
function sanitizeGeneratedHtml(html) {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*/gi, '')
    .replace(/[\s/]on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/[\s/]on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/[\s/]on\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*"\s*(javascript|data):[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'\s*(javascript|data):[^']*'/gi, "$1='#'")

  // Resource-loading tags with no legitimate role in a static resume PDF —
  // removed entirely rather than trying to sanitize their src/content.
  // Container tags (iframe/object/video/audio) have their closing tag and
  // any content between stripped too, not just the opening tag.
  out = out.replace(/<(iframe|object|video|audio)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  out = out.replace(/<(img|iframe|object|embed|frame|video|audio|source|track|base)\b[^>]*\/?>/gi, '')
  // <meta http-equiv="refresh" ...> can navigate the page with no JS at all.
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '')

  // HARDENING: the legacy HTML `background="..."` attribute (on <body>,
  // <table>, <td>, <th>) is obsolete but still rendered by Chromium (the
  // engine behind Cloudflare Browser Rendering) as a background-image
  // fetch — a request-triggering attribute that the href/src-only stripping
  // above never touched. Same threat as the resource tags above: a
  // successful prompt injection in resumeData could get this generation
  // call to emit `background="http://169.254.169.254/..."` and Browser
  // Rendering would fetch it with zero JS involved. Stripped outright,
  // same posture as the other legacy resource-loading vectors.
  out = out.replace(/[\s/]background\s*=\s*"[^"]*"/gi, '')
  out = out.replace(/[\s/]background\s*=\s*'[^']*'/gi, '')
  out = out.replace(/[\s/]background\s*=\s*[^\s>]+/gi, '')

  // HARDENING: SVG's <image> element (distinct from HTML's <img>, so the
  // resource-tag strip above — which matches the literal tag name "img" —
  // never catches it) also fires a network fetch via xlink:href/href. The
  // prompt only asks for a plain resume layout with no SVG, but this closes
  // the gap defensively rather than relying on the model never emitting one.
  out = out.replace(/<image\b[^>]*\/?>/gi, '')

  // <link href="...">: keep only if it targets an allowlisted font host
  // (the prompt legitimately requests @import fonts from Google) — strip
  // everything else (favicons, arbitrary external stylesheets, etc.)
  // <link href="...">: keep only if it targets an allowlisted font host
  // (the prompt legitimately requests @import fonts from Google) — strip
  // everything else (favicons, arbitrary external stylesheets, etc.)
  //
  // BUG FIX (audit): the href match required quotes — an unquoted attribute
  // (`<link href=https://fonts.googleapis.com/... rel=stylesheet>`, valid
  // HTML) had no match, so `m` was null and the tag was stripped entirely
  // even though it targeted an allowed host. Fails safe (over-removes rather
  // than under-removes) but silently breaks the one thing this block exists
  // to let through. Now accepts double-quoted, single-quoted, or unquoted,
  // matching how the CSS url() check below already handles all three.
  out = out.replace(/<link\b[^>]*>/gi, tag => {
    const m = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const href = m && (m[1] ?? m[2] ?? m[3])
    return (href && isAllowedResourceUrl(href)) ? tag : ''
  })

  // CSS url(...) — inside <style> blocks and inline style="" attributes
  // alike (background-image, @font-face src, list-style-image, etc).
  // Neutralize any target that isn't an allowlisted font host.
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, _q, target) =>
    isAllowedResourceUrl(target) ? full : 'url()'
  )

  // @import — same allowlist, whether written as @import url(...) or the
  // bare-string form @import "...".
  out = out.replace(/@import\s+(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"])/gi,
    (full, u1, u2) => isAllowedResourceUrl(u1 || u2) ? full : ''
  )

  return out
}

// detectFabrication and sanitizeGeneratedHtml were previously internal-only.
// Exported (in addition to being used internally by rewriteResumeContent /
// generateBeautifulResumeHTML above) so they're directly unit-testable —
// see tests/claude.service.test.js — rather than only reachable through a
// full Claude API round trip.
module.exports = { scoreResumeWithAI, parseResumeStructure, structureFreeformText, rewriteResumeContent, generateBeautifulResumeHTML, extractJson, detectFabrication, sanitizeGeneratedHtml, isAllowedResourceUrl }
