// "We'll reach out when we have candidates matching your role" — the promise
// on both employer forms — had no machinery behind it: the admin list showed a
// per-field supply number, but nothing told anyone when a field that leads are
// WAITING on actually gained a verified candidate. This is that signal: an
// owner digest, sent from the hourly cron, of the fields where
//   (a) at least one lead is still open (NEW or CONTACTED), and
//   (b) verified-candidate supply has grown since the last digest.
//
// The digest goes to the owner only (a person decides whom to write to and
// what to say); nothing here emails a lead. State is one small JSON blob in
// KV — `supply` is the per-field count as of the last digest (lowered
// whenever supply falls, e.g. after a revocation, so a later rise announces
// again) and `sentAt` enforces at most one digest per MIN_INTERVAL, however
// fast supply grows.

const emailService = require('./email.service')

const STATE_KEY = 'leadmatch:state'
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000
const STATE_TTL_SECONDS = 400 * 24 * 60 * 60

const label = (cat) => cat.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())

async function loadState(kv) {
  try {
    const raw = await kv.get(STATE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object')
      return { supply: (parsed.supply && typeof parsed.supply === 'object') ? parsed.supply : {}, sentAt: Number(parsed.sentAt) || 0 }
  } catch (_) { /* corrupt state: start over */ }
  return { supply: {}, sentAt: 0 }
}

// Pure: which fields are worth announcing, given supply now, leads waiting and
// what was announced last time.
function computeAnnouncements(supply, waiting, announced) {
  const out = []
  for (const [cat, count] of Object.entries(supply)) {
    const leads = waiting[cat] || 0
    const before = Number(announced[cat]) || 0
    if (count > 0 && leads > 0 && count > before) out.push({ cat, candidates: count, before, leads })
  }
  return out.sort((a, b) => b.leads - a.leads || a.cat.localeCompare(b.cat))
}

async function runLeadMatchSweep(env, supabase, now = Date.now()) {
  const kv = env.RATE_LIMIT_KV
  if (!kv) return { skipped: 'no-kv' }

  const { data: rows, error: rpcErr } = await supabase.rpc('verified_candidate_counts')
  if (rpcErr) return { error: rpcErr.message }
  const supply = Object.fromEntries((rows || []).map(r => [r.role_category, Number(r.candidate_count)]))

  // Counted in the database (open = NEW or CONTACTED, with a field). This used
  // to SELECT up to 5000 rows and tally in JS, but PostgREST answers at most
  // its max-rows (1000 by default), so the count silently stopped there.
  const { data: leadRows, error: leadErr } = await supabase.rpc('open_lead_counts')
  if (leadErr) return { error: leadErr.message }
  const waiting = Object.fromEntries((leadRows || []).map(r => [r.role_category, Number(r.lead_count)]))

  const state = await loadState(kv)

  // Keep the baseline honest when supply falls, so a later recovery counts as
  // growth again. This is bookkeeping, not an announcement.
  let dirty = false
  for (const cat of Object.keys(state.supply)) {
    const cur = supply[cat] || 0
    if (cur < state.supply[cat]) { state.supply[cat] = cur; dirty = true }
  }

  const due = computeAnnouncements(supply, waiting, state.supply)
  let sent = false
  if (due.length && now - state.sentAt >= MIN_INTERVAL_MS) {
    const base = env.FRONTEND_URL || ''
    const lines = due.map(a =>
      `${label(a.cat)}: ${a.leads} open lead${a.leads === 1 ? '' : 's'} · ${a.candidates} verified candidate${a.candidates === 1 ? '' : 's'}` +
      `${a.before ? ` (was ${a.before})` : ''}\n  ${base}/admin/leads?field=${a.cat}`)
    const delivered = await emailService.sendOwnerNotice(env, 'Verified candidates now available for waiting leads',
      `Fields where leads are waiting and verified supply has grown:\n\n${lines.join('\n\n')}`)
    // sendOwnerNotice answers false (it does not throw) when there is no owner
    // inbox configured. Recording the announcement anyway would swallow it for
    // good — adding OWNER_ALERT_EMAIL later would never re-announce fields
    // whose supply had already been "announced" to nobody. Not delivered =
    // not announced: state stays put and the next sweep tries again.
    if (delivered) {
      for (const a of due) state.supply[a.cat] = a.candidates
      state.sentAt = now
      sent = true
      dirty = true
    } else {
      console.warn('lead-match: digest not delivered (no owner inbox configured?) — will retry on the next sweep')
    }
  }
  if (dirty) await kv.put(STATE_KEY, JSON.stringify(state), { expirationTtl: STATE_TTL_SECONDS })
  return { announced: sent ? due.length : 0, pending: sent ? 0 : due.length }
}

module.exports = { runLeadMatchSweep, computeAnnouncements, MIN_INTERVAL_MS }
