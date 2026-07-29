// Ported from Express/Prisma to Hono/Supabase. The one subtle point worth
// flagging: v8's atomic idempotency check used Prisma's
// `updateMany({ where: { status: 'PENDING' } })` and checked the returned
// `count`. Supabase's equivalent is `.update().eq('status','PENDING').select()`
// — Postgres only returns rows that matched the WHERE clause AT THE MOMENT OF
// THE UPDATE, which is the same atomic guarantee Prisma's updateMany gave:
// under a race between this endpoint and the webhook, only one caller's
// UPDATE...RETURNING will see status='PENDING' and get a row back; the other
// gets an empty array. `updatedRows.length` replaces `count`.
//
// generateFix/generateBadge calls are dispatched via FIX_QUEUE (see
// index.js's queue() handler) rather than run inline — see that handler's
// comment block for why waitUntil() isn't viable here (30s wall-clock cap,
// non-catchable kill on timeout).

const c = require('../config/constants')
const { getSupabase } = require('../config/supabase')
const cryptoLib = require('../lib/crypto')
const { scanRowToCamel } = require('../lib/mappers')
const paystackService = require('../services/paystack.service')
const emailService = require('../services/email.service')

// POST /api/payments/initialize
async function initializePayment(c2) {
  const user = c2.get('user')
  const body = await c2.req.json()
  const { scanId, fixTier } = body
  if (!scanId || !['FIX', 'BADGE'].includes(fixTier))
    return c2.json({ success: false, message: 'scanId and valid fixTier required.' }, 400)

  const supabase = getSupabase(c2.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', scanId).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan || scan.userId !== user.id)
    return c2.json({ success: false, message: 'Access denied.' }, 403)
  if (scan.fixPurchased)
    return c2.json({ success: false, message: 'Already purchased.' }, 400)
  if (!['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status))
    return c2.json({ success: false, message: 'Scan must be complete.' }, 400)
  if (fixTier === 'BADGE' && (scan.atsScore || 0) < c.ATS_BADGE_THRESHOLD)
    return c2.json({ success: false, message: `Badge requires score >= ${c.ATS_BADGE_THRESHOLD}` }, 400)

  const amount    = fixTier === 'BADGE' ? c.PRICE_BADGE : c.PRICE_FIX
  const reference = cryptoLib.uuid()  // generated ONCE — passed to both Paystack and DB

  // Call Paystack FIRST — if it fails, no orphan record is created
  let result
  try {
    result = await paystackService.initializeTransaction(c2.env, {
      email: user.email, amount, userId: user.id, scanId, fixTier, reference
    })
  } catch (err) {
    console.error(`[CRITICAL] Paystack initialize failed (scan ${scanId}):`, err.message)
    try {
      await emailService.sendOwnerAlert(c2.env,
        'Paystack initialize failed — payments may be blocked',
        `Every payment attempt fails until this is resolved.\n\nuserId: ${user.id}\nscanId: ${scanId}\nfixTier: ${fixTier}\namount: ${amount}\nerror: ${err.message}`
      )
    } catch (_) {}
    return c2.json({ success: false,
      message: 'Payment could not be started right now. We\'ve been notified — please try again shortly.'
    }, 502)
  }

  // Paystack confirmed — now safe to create the DB record
  const { error: insertErr } = await supabase.from('payments').insert({
    amount_cents:          amount,
    currency:              c2.env.PAYSTACK_CURRENCY || c.CURRENCY,
    status:                'PENDING',
    paystack_ref:          reference,
    paystack_access_code:  result.access_code,
    user_id:               user.id,
    scan_id:               scanId
  })
  if (insertErr) throw insertErr

  // Store fixTier on scan for routing in verify/webhook
  await supabase.from('scans').update({ fix_tier: fixTier }).eq('id', scanId)

  return c2.json({ success: true, data: {
    authorization_url: result.authorization_url,
    access_code:        result.access_code,
    reference
  }})
}

// GET /api/payments/verify?reference=xxx
async function verifyPayment(c2) {
  const reference = c2.req.query('reference') || c2.req.query('trxref')
  if (!reference) return c2.json({ success: false, message: 'Missing reference.' }, 400)

  const supabase = getSupabase(c2.env)
  let pResult
  try {
    pResult = await paystackService.verifyTransaction(c2.env, reference)
  } catch (err) {
    console.error(`[CRITICAL] Paystack verify failed (ref ${reference}):`, err.message)
    try {
      await emailService.sendOwnerAlert(c2.env,
        'Paystack verify failed — a payment may be stuck',
        `reference: ${reference}\nerror: ${err.message}`
      )
    } catch (_) {}
    return c2.json({ success: false, message: 'Payment verification failed.' }, 502)
  }
  if (pResult.data?.status !== 'success' || pResult.data?.currency !== (c2.env.PAYSTACK_CURRENCY || c.CURRENCY))
    return c2.json({ success: false, message: 'Payment verification failed.' }, 400)

  const authCode = pResult.data?.authorization?.authorization_code

  // Atomic idempotency — UPDATE...RETURNING only matches rows that were
  // still PENDING at update time, same guarantee as Prisma's updateMany count.
  const { data: updatedRows, error: updErr } = await supabase
    .from('payments')
    .update({ status: 'SUCCESS', paystack_auth_code: authCode })
    .eq('paystack_ref', reference)
    .eq('status', 'PENDING')
    .select()
  if (updErr) throw updErr

  if (updatedRows.length === 0) {
    const { data: existing } = await supabase.from('payments').select('scan_id').eq('paystack_ref', reference).maybeSingle()
    return c2.json({ success: true, data: { scanId: existing?.scan_id } })
  }

  const payment = updatedRows[0]
  await supabase.from('scans').update({ fix_purchased: true, status: 'FIX_PURCHASED' }).eq('id', payment.scan_id)

  const { data: scanRow } = await supabase.from('scans').select('fix_tier').eq('id', payment.scan_id).maybeSingle()
  const fixTier = scanRow?.fix_tier || 'FIX'

  const generatorType = fixTier === 'BADGE' ? 'generateBadge' : 'generateFix'
  // Enqueue instead of running inline via waitUntil() — generateFix/
  // generateBadge (two Claude calls + a Browser Rendering PDF render) can
  // easily exceed the 30-second waitUntil wall-clock cap, which silently
  // kills the task with no catchable error. The queue consumer (index.js)
  // has no such cap. See index.js's queue() handler for the full rationale.
  await c2.env.FIX_QUEUE.send({ type: generatorType, scanId: payment.scan_id })

  return c2.json({ success: true, data: { scanId: payment.scan_id } })
}

// GET /api/payments/history
async function getPaymentHistory(c2) {
  const user = c2.get('user')
  const supabase = getSupabase(c2.env)
  const { data: rows, error } = await supabase
    .from('payments')
    .select('id, amount_cents, currency, status, paystack_ref, created_at, scan_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
  if (error) throw error

  const payments = rows.map(r => ({
    id: r.id, amountCents: r.amount_cents, currency: r.currency, status: r.status,
    paystackRef: r.paystack_ref, createdAt: r.created_at, scanId: r.scan_id
  }))

  return c2.json({ success: true, data: { payments } })
}

module.exports = { initializePayment, verifyPayment, getPaymentHistory }
