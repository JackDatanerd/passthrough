// Chainable fake of the slice of the supabase-js query builder this codebase uses.
//
// Unlike the inline fakes the original tests used (which returned the same row no
// matter WHICH column or value was queried — so a bug in the lookup could never
// fail a test), this records every call. Tests can assert what was filtered on:
//
//   const db = createFakeSupabase(q => q.table === 'users' ? { data: row } : undefined)
//   ...
//   expect(eqValue(db.calls[0], 'code')).toBe('COACH20')
//
// `resolver(query)` receives { table, op, filters, patch, values, cols, single, maybe }
// (or { op:'rpc', name, args }) and returns { data, error } (or undefined -> empty success).

function createFakeSupabase(resolver = () => undefined) {
  const calls = []

  function from(table) {
    const q = { table, op: 'select', filters: [], orders: [], patch: null, values: null, cols: null, single: false, maybe: false, returning: false }
    const run = () => {
      calls.push(q)
      return Promise.resolve(resolver(q)).then(r => r ?? { data: null, error: null })
    }
    const api = {
      select(cols, opts) { q.cols = cols ?? '*'; q.selectOpts = opts || null; q.returning = true; return api },
      insert(values) { q.op = 'insert'; q.values = values; return api },
      update(patch) { q.op = 'update'; q.patch = patch; return api },
      delete() { q.op = 'delete'; return api },
      upsert(values, opts) { q.op = 'upsert'; q.values = values; q.onConflict = opts && opts.onConflict; q.ignoreDuplicates = !!(opts && opts.ignoreDuplicates); return api },
      order(col, opts) { q.orders.push([col, opts]); return api },
      // range/or/limit are recorded (q.range / q.or / q.limit) so tests can
      // assert on them, or a bespoke resolver can apply them; before, all
      // three were silently dropped.
      limit(n) { q.limit = n; return api },
      range(from, to) { q.range = [from, to]; return api },
      or(expr) { (q.or = q.or || []).push(expr); return api },
      maybeSingle() { q.maybe = true; return run() },
      single() { q.single = true; return run() },
      then(resolve, reject) { return run().then(resolve, reject) },
    }
    for (const f of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike'])
      api[f] = (col, val) => { q.filters.push([f, col, val]); return api }
    // .contains(col, [ {..} ]) — jsonb/array containment (@>)
    api.contains = (col, val) => { q.filters.push(['contains', col, val]); return api }
    api.not = (col, op, val) => { q.filters.push(['not', col, op, val]); return api }
    return api
  }

  function rpc(name, args) {
    const q = { table: null, op: 'rpc', name, args, filters: [] }
    calls.push(q)
    return Promise.resolve(resolver(q)).then(r => {
      if (r !== undefined) return r
      if (name === 'record_payout_settlement') return emulateRecordPayoutSettlement(args)
      return { data: null, error: null }
    })
  }

  // The resolver of a test written before migration 0087 stubs the individual PostgREST calls the old controller made
  // (payouts insert / commission_ledger claim / payouts patch or delete). When it does not answer the
  // record_payout_settlement RPC itself, replay the RPC's body against those stubs — same statements, same order as the SQL
  // function — so those tests keep asserting the settlement behaviour. Real SQL behaviour is covered by migrations.0087.pglite.test.js.
  async function emulateRecordPayoutSettlement(a) {
    const step = async (table, op, extra) => {
      const sub = { table, op, filters: [], orders: [], patch: null, values: null, cols: '*', single: false, maybe: false, returning: true, ...extra }
      calls.push(sub)
      return (await resolver(sub)) ?? { data: null, error: null }
    }
    const ins = await step('payouts', 'insert', { values: { partner_id: a.p_partner_id, ...a.p_payout }, single: true })
    if (ins.error) return { data: null, error: ins.error }
    let payout = ins.data
    const ids = a.p_ledger_ids || []
    let claimed = []
    if (ids.length) {
      const c = await step('commission_ledger', 'update', {
        patch: { payout_id: payout.id },
        filters: [['in', 'id', ids], ['eq', 'partner_id', a.p_partner_id], ['is', 'payout_id', null]],
      })
      if (c.error) return { data: null, error: c.error }
      claimed = c.data || []
    }
    const claimedCents = claimed.reduce((n, r) => n + (r.commission_amount_cents || 0), 0)
    let discarded = false
    if (claimed.length < ids.length) {
      if (a.p_discard_if_empty && claimed.length === 0) {
        await step('payouts', 'delete', { filters: [['eq', 'id', payout.id]] })
        discarded = true
      } else {
        const patch = { settled_commission_cents: claimedCents, ...(a.p_amount_is_auto ? { amount_cents: claimedCents } : {}) }
        const u = await step('payouts', 'update', { patch, filters: [['eq', 'id', payout.id]], single: true })
        if (u.error) return { data: null, error: u.error }
        payout = u.data || { ...payout, ...patch }
      }
    }
    return { data: { payout, requested: ids.length, claimed: claimed.length, claimed_cents: claimedCents, discarded }, error: null }
  }

  return { from, rpc, calls }
}

// Value of the first `.eq(col, value)` filter on a recorded query.
function eqValue(query, col) {
  const hit = (query.filters || []).find(f => f[0] === 'eq' && f[1] === col)
  return hit ? hit[2] : undefined
}

module.exports = { createFakeSupabase, eqValue }
