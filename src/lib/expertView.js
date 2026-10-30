'use strict'

// Experts: what an assigned expert is ALLOWED TO READ of the customer's words. The customer's structured resume is locked by humanLocks;
// everything else the customer typed (the brief, an answer to a question, a revision note) and the posting itself is scrubbed here, at
// read time, with the same engine and the customer's own contact values: contact details, street addresses, the customer's name, and
// the employer's name are replaced with plain tokens. If the sealed values cannot be loaded the scrub still runs on patterns alone.
const locks = require('./humanLocks')
const { companyFromPosting } = require('./jobCompany')

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const COMPANY_TOKEN = '[the company]'

// The employer's name is hidden from the expert (product spec 6.3). Only a name the extractor is sure of is replaced; case does not matter,
// the possessive goes with it, and a name ending in a symbol ("Yahoo!") is still found.
function maskName(text, name) {
  let t = String(text == null ? '' : text); if (!name) return t
  const bound = re => `(?<![\\p{L}\\p{N}_])${re}(?![\\p{L}\\p{N}_])`
  t = t.replace(new RegExp(bound(escapeRe(name).replace(/\s+/g, '\\s+')), 'giu'), COMPANY_TOKEN)
  // the short form a posting uses after the first mention ("Acme" for "Acme Corp"), matched with the capitalisation it is written in
  const short = name.replace(/[\s,]+(?:inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pty|sa|ag|bv|nv)\.?$/i, '').trim()
  if (short !== name && short.length >= 3) {
    const forms = [...new Set([short, short.toUpperCase(), short[0].toUpperCase() + short.slice(1).toLowerCase()])]
    t = t.replace(new RegExp(bound(`(?:${forms.map(f => escapeRe(f)).join('|')})`), 'gu'), COMPANY_TOKEN)
  }
  return t
}
function maskCompany(text) { const t = String(text || ''); return maskName(t, companyFromPosting(t)) }

async function loadMaskContext(env, supabase, jobId) {
  let locked = {}
  try {
    const fieldCrypto = require('./fieldCrypto')
    const { data, error } = await supabase.from('job_locked_values').select('path, value_enc').eq('job_id', jobId)
    if (!error) for (const r of data || []) { try { locked[r.path] = await fieldCrypto.openTaxId(env, r.value_enc) } catch (_) { /* one value unreadable: scrub with the rest */ } }
  } catch (err) { console.error('expert view: sealed values unavailable, scrubbing by pattern only:', err.message); locked = {} }
  return locks.maskingContext(locked)
}

function scrub(v, ctx, company) {
  if (typeof v === 'string') return locks.redactText(maskName(v, company), ctx)
  if (Array.isArray(v)) return v.map(x => scrub(x, ctx, company))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, ctx, company)]))
  return v
}

// the brief, the job's free-text fields, the customer's answers and the materials, as an expert may read them
function presentForExpert({ job, brief, questions, materials }, ctx) {
  const b = brief || {}; const company = companyFromPosting(String(b.jobPosting || ''))
  return {
    brief: scrub(b, ctx, company),
    job: job ? { ...job, revision_reason: job.revision_reason == null ? job.revision_reason : scrub(job.revision_reason, ctx, company) } : job,
    questions: (questions || []).map(q => ({ ...q, answer_body: q.answer_body == null ? q.answer_body : scrub(q.answer_body, ctx, company) })),
    materials: (materials || []).map(m => ({ ...m, label: scrub(m.label, ctx, company), text: scrub(m.text, ctx, company) })),
  }
}

module.exports = { maskCompany, maskName, loadMaskContext, presentForExpert }
