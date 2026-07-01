// Identical logic to v8. Only change: Workers have no `process.env`, so every
// function takes `env` (the Worker's bindings object) as its first parameter
// instead of reading ANTHROPIC_API_KEY/ANTHROPIC_MODEL from a global.

function model(env) {
  return env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
}

async function callClaude(env, system, userMsg, maxTokens) {
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
      })
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error?.message || 'Claude API error')
    return { success: true, data: json.content[0].text, error: null }
  } catch (err) {
    console.error('Claude error:', err.message)
    return { success: false, data: null, error: err.message }
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

async function parseResumeStructure(env, rawText) {
  const result = await callClaude(
    env,
    'Extract resume data. Return ONLY valid JSON.',
    `Extract from:\n${rawText}\nReturn: {"name":"","email":"","phone":null,"location":null,"summary":null,` +
    `"experience":[{"company":"","title":"","dates":"","bullets":[]}],` +
    `"education":[{"institution":"","degree":"","dates":""}],"skills":[],"certifications":[]}`,
    2000
  )
  if (!result.success) return result
  try { return { success: true, data: JSON.parse(result.data), error: null } }
  catch (_) { return { success: false, data: null, error: 'PARSE_FAIL' } }
}

async function rewriteResumeContent(env, resumeData, jdText) {
  const result = await callClaude(
    env,
    `ATS resume writer. Incorporate JD keywords naturally.
     NEVER fabricate employers, institutions, credentials, or dates not in input.
     Optimize for US and UK employer expectations. Use standard US resume conventions — avoid regional formatting, idioms, or terminology that may be unfamiliar to North American or European hiring managers.
     Return ONLY valid JSON matching exact input schema.`,
    `Resume:\n${JSON.stringify(resumeData)}\n\nJD:\n${jdText}\nReturn same JSON structure.`,
    4000
  )
  if (!result.success) return result
  // CRITICAL: result.data is a raw string — must parse before use as object
  let rewritten
  try { rewritten = JSON.parse(result.data) }
  catch (_) { return { success: false, data: null, error: 'PARSE_FAIL' } }
  if (detectFabrication(resumeData, rewritten))
    return { success: false, data: null, error: 'FABRICATION_DETECTED' }
  return { success: true, data: rewritten, error: null }
}

function detectFabrication(orig, rewritten) {
  const norm = s => (s || '').toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|university|institute|college|group)\b/g, '')
    .replace(/[.,]/g, '').trim()
  const origAll = [
    ...(orig.experience || []).map(e => norm(e.company)),
    ...(orig.education  || []).map(e => norm(e.institution))
  ].filter(Boolean)
  const newAll = [
    ...(rewritten.experience || []).map(e => norm(e.company)),
    ...(rewritten.education  || []).map(e => norm(e.institution))
  ].filter(Boolean)
  for (const n of newAll)
    if (!origAll.some(o => o.includes(n) || n.includes(o))) return true
  return false
}

async function generateBeautifulResumeHTML(env, resumeData, designTokens, verificationUrl) {
  const { palette, fonts } = designTokens
  const result = await callClaude(
    env,
    'Senior UI designer. Generate complete self-contained HTML resume. Raw HTML only, no markdown.',
    `CANDIDATE: ${JSON.stringify(resumeData)}
     VERIFICATION URL: ${verificationUrl}
     Colors: bg=${palette.bg} primary=${palette.primary} accent=${palette.accent} text=${palette.text}
     Fonts: heading=${fonts.heading} body=${fonts.body} hPt=${fonts.hPt} bPt=${fonts.bPt}
     Header line 3 MUST be: <a href="${verificationUrl}" style="text-decoration:none">
       <span style="color:${palette.primary};font-size:8pt;font-variant:small-caps">✓ Passthrough Verified</span>
     </a> — URL hidden, only "✓ Passthrough Verified" visible as clickable link.
     Single column, left spine 4px solid ${palette.primary}, A4 size, @import fonts from Google.
     -webkit-print-color-adjust:exact. No JavaScript. No fabrication.
     OUTPUT: Raw HTML starting with <!DOCTYPE html>`,
    4000
  )
  if (!result.success) return result
  if (!result.data?.trimStart().startsWith('<!DOCTYPE') && !result.data?.trimStart().startsWith('<html'))
    return { success: false, data: null, error: 'INVALID_HTML' }
  return { success: true, data: result.data.replace(/<script[\s\S]*?<\/script>/gi, ''), error: null }
}

module.exports = { scoreResumeWithAI, parseResumeStructure, rewriteResumeContent, generateBeautifulResumeHTML }
