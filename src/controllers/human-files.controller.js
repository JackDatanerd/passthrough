// Experts Phase 1: supporting materials (customer) and delivered files (customer). Kept apart from human.controller.js so each file
// stays readable. Same flag gate and allow-list.
const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const pilot = require('../lib/humanPilot')
const locks = require('../lib/humanLocks')
const fieldCrypto = require('../lib/fieldCrypto')
const human = require('./human.controller')
const { loadShared, saveNewLocked, ownJob, guardUser, bad, isUuid } = human._internal

const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
const KIND_FILE = { docx: { name: 'resume.docx', mime: MIME.docx }, pdf: { name: 'resume.pdf', mime: MIME.pdf }, cover: { name: 'cover-letter.docx', mime: MIME.docx } }
const BEFORE_CLAIM = ['awaiting_payment', 'offered', 'open']
const MIN_TEXT_CHARS = 200
const MAX_TEXT_CHARS = 60000

// Adds one supporting file: stored original (customer-only), extracted text masked into the job's lock map (the expert sees only that).
async function addMaterial(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const supabase = getSupabase(ctx.env)
  const s = await pilot.loadSettings(supabase); if (!s) return bad(ctx, 'Not available right now.', 503)
  const j = await ownJob(ctx, supabase, g.user, ctx.req.param('id'), 'id, state'); if (!j) return bad(ctx, 'Order not found.', 404)
  if (!BEFORE_CLAIM.includes(j.state)) return bad(ctx, 'An expert has this order now. If you have more to tell them, answer their question when they ask.', 409)
  let form; try { form = await ctx.req.parseBody() } catch (_) { return bad(ctx, 'Please choose a file.') }
  const file = form && form.file
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return bad(ctx, 'Please choose a file.')
  if (file.size > s.materials_max_bytes) return bad(ctx, `That file is larger than ${Math.round(s.materials_max_bytes / 1048576)} MB.`, 413)
  const mime = file.type === MIME.pdf ? MIME.pdf : file.type === MIME.docx ? MIME.docx : null
  if (!mime) return bad(ctx, 'Word (.docx) and PDF files only. Photos and scans cannot be masked reliably.', 415)
  const { data: have } = await supabase.from('job_materials').select('id').eq('job_id', j.id).eq('kind', 'file').neq('status', 'removed')
  if ((have || []).length >= s.materials_max_files) return bad(ctx, `You can add up to ${s.materials_max_files} files.`, 409)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const text = (await require('../services/resume.parser').extractText(bytes, mime)) || ''
  if (text.trim().length < MIN_TEXT_CHARS) return bad(ctx, 'We could not read text from that file. Please use a Word or text-based PDF file.', 422)

  const shared = await loadShared(ctx.env, supabase, j.id)
  const before = new Set(Object.keys(shared.locked))
  // the client's name comes from the lock map frozen when the order was placed (their later edits to the scan do not change what we hide)
  let name = shared.locked['lock:name']
  if (!name) {
    const { data: scanRow } = await supabase.from('human_jobs').select('scan_id').eq('id', j.id).maybeSingle()
    const { data: sc } = scanRow && scanRow.scan_id ? await supabase.from('scans').select('original_resume_data').eq('id', scanRow.scan_id).maybeSingle() : { data: null }
    name = sc && sc.original_resume_data && sc.original_resume_data.name
  }
  const truncated = text.length > MAX_TEXT_CHARS
  const masked = locks.lockText(text.slice(0, MAX_TEXT_CHARS), shared, name)
  const key = `human/${j.id}/materials/${crypto.randomUUID()}`
  await ctx.env.RESUMES_BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } })
  try {
    await saveNewLocked(ctx.env, supabase, j.id, shared, before)
    const { data: row, error } = await supabase.from('job_materials').insert({ job_id: j.id, kind: 'file', label: String(file.name || 'file').slice(0, 120), extracted_masked_text: masked, original_object_key: key }).select('id').single()
    if (error) throw error
    // the checks above ran before a slow parse and upload: re-check now that the row exists, and back out if two uploads raced past the limit or an expert took the order meanwhile
    const [{ data: nowHave }, { data: nowJob }] = await Promise.all([
      supabase.from('job_materials').select('id').eq('job_id', j.id).eq('kind', 'file').neq('status', 'removed'),
      supabase.from('human_jobs').select('state').eq('id', j.id).maybeSingle(),
    ])
    const overLimit = (nowHave || []).length > s.materials_max_files, claimed = !nowJob || !BEFORE_CLAIM.includes(nowJob.state)
    if (overLimit || claimed) {
      await supabase.from('job_materials').update({ status: 'removed', extracted_masked_text: null, original_object_key: null }).eq('id', row.id)
      await ctx.env.RESUMES_BUCKET.delete(key).catch(() => {})
      return bad(ctx, overLimit ? `You can add up to ${s.materials_max_files} files.` : 'An expert has this order now. If you have more to tell them, answer their question when they ask.', 409)
    }
    await supabase.from('job_events').insert({ job_id: j.id, kind: 'material_added', actor_kind: 'customer', actor_id: g.user.id, detail: { kind: 'file' } })
    return ctx.json({ success: true, data: { id: row.id, truncated } })
  } catch (err) {
    await ctx.env.RESUMES_BUCKET.delete(key).catch(() => {})
    throw err
  }
}

const linkBody = z.object({ url: z.string().trim().url().max(500), label: z.string().trim().max(120).optional() }).strict()
// Links are kept for the operator only: nothing here can fetch and mask a web page, so an expert is never shown one.
async function addLink(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const p = linkBody.safeParse(await (async () => { try { return await ctx.req.json() } catch (_) { return undefined } })())
  if (!p.success || !/^https?:\/\//i.test(p.data.url)) return bad(ctx, 'Please enter a web address starting with http:// or https://.')
  const supabase = getSupabase(ctx.env)
  const j = await ownJob(ctx, supabase, g.user, ctx.req.param('id'), 'id, state'); if (!j) return bad(ctx, 'Order not found.', 404)
  if (!BEFORE_CLAIM.includes(j.state)) return bad(ctx, 'An expert has this order now.', 409)
  const { data: have } = await supabase.from('job_materials').select('id').eq('job_id', j.id).eq('kind', 'link').neq('status', 'removed')
  if ((have || []).length >= 5) return bad(ctx, 'You can add up to 5 links.', 409)
  const { data: row, error } = await supabase.from('job_materials').insert({ job_id: j.id, kind: 'link', label: p.data.label || null, link_url: p.data.url }).select('id').single()
  if (error) throw error
  const { data: nowHave } = await supabase.from('job_materials').select('id').eq('job_id', j.id).eq('kind', 'link').neq('status', 'removed')
  if ((nowHave || []).length > 5) { await supabase.from('job_materials').update({ status: 'removed', link_url: null }).eq('id', row.id); return bad(ctx, 'You can add up to 5 links.', 409) }
  return ctx.json({ success: true, data: { id: row.id } })
}

async function removeMaterial(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const mid = ctx.req.param('mid'); if (!isUuid(mid)) return bad(ctx, 'Not found.', 404)
  const supabase = getSupabase(ctx.env)
  const j = await ownJob(ctx, supabase, g.user, ctx.req.param('id'), 'id, state'); if (!j) return bad(ctx, 'Order not found.', 404)
  if (!BEFORE_CLAIM.includes(j.state)) return bad(ctx, 'An expert has this order now.', 409)
  const { data: m } = await supabase.from('job_materials').select('id, original_object_key').eq('id', mid).eq('job_id', j.id).maybeSingle()
  if (!m) return bad(ctx, 'Not found.', 404)
  const { error: ue } = await supabase.from('job_materials').update({ status: 'removed', extracted_masked_text: null, link_url: null, original_object_key: null }).eq('id', mid)
  if (ue) throw ue                                                  // the row still points at the file: keep the file
  if (m.original_object_key) await ctx.env.RESUMES_BUCKET.delete(m.original_object_key).catch(() => {})
  return ctx.json({ success: true })
}

// The delivered files, from the newest delivery, to the order's owner only.
async function downloadFile(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const kind = ctx.req.param('kind'); const spec = KIND_FILE[kind]; if (!spec) return bad(ctx, 'Not found.', 404)
  const supabase = getSupabase(ctx.env)
  const j = await ownJob(ctx, supabase, g.user, ctx.req.param('id'), 'id, state, job_number'); if (!j) return bad(ctx, 'Order not found.', 404)
  if (!['delivered', 'accepted', 'revision'].includes(j.state)) return bad(ctx, 'Not ready yet.', 409)
  const { data: d } = await supabase.from('job_deliveries').select('files').eq('job_id', j.id).order('version', { ascending: false }).limit(1).maybeSingle()
  const key = d && d.files && d.files[kind]
  if (!key) return bad(ctx, 'That file is not part of this order.', 404)
  const obj = await ctx.env.RESUMES_BUCKET.get(key)
  if (!obj) return bad(ctx, 'The file is no longer available. Contact support and quote your order number.', 410)
  return new Response(obj.body, { status: 200, headers: { 'Content-Type': spec.mime, 'Content-Disposition': `attachment; filename="${j.job_number}-${spec.name}"`, 'Cache-Control': 'private, no-store' } })
}

module.exports = { addMaterial, addLink, removeMaterial, downloadFile }
