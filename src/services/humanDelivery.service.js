'use strict'

// Experts Phase 1: the operator's review and delivery of a finished job (Appendix F.3: the founder reviews every delivery).
//   buildReview  -> the restored resume for the operator to read, the checks, and what is blocking delivery
//   deliver      -> re-score, build the Word and PDF files, store them, move the job to delivered, tell the customer
// Locked values are put back ONLY here, server side, for the operator and for the files the customer receives. Every read of a
// job's content by the operator is written to the audit log.

const pilot = require('../lib/humanPilot')
const locks = require('../lib/humanLocks')
const fieldCrypto = require('../lib/fieldCrypto')
const { diffDocuments } = require('../lib/humanDiff')
const { newFiguresDetailed } = require('../lib/humanFacts')

async function logView(supabase, operatorId, action, jobId, detail = {}) {
  const { error } = await supabase.from('expert_audit_log').insert({ actor_kind: 'operator', actor_id: operatorId || null, action, target_type: 'human_job', target_id: jobId, detail })
  if (error) throw error
}

async function latestDoc(supabase, jobId, kind) {
  const { data, error } = await supabase.from('job_documents').select('version, body, cover_letter').eq('job_id', jobId).eq('kind', kind).order('version', { ascending: false }).limit(1)
  if (error) throw error
  return (data && data[0]) || null
}

async function loadLocked(env, supabase, jobId) {
  const { data, error } = await supabase.from('job_locked_values').select('path, value_enc').eq('job_id', jobId)
  if (error) throw error
  const locked = {}
  for (const r of data || []) locked[r.path] = await fieldCrypto.openSealedStrict(env, r.value_enc)   // an unreadable value must stop the review: a blank would ship a resume with no name or email
  return locked
}

// Everything the CUSTOMER gave us that makes a figure "already known": their original resume, any edit they made themselves, the brief,
// the guided top results, answered questions, and the masked text of supporting files. NOT the AI draft and NOT the job posting: a
// figure only those carry is still flagged (and labelled with where it came from), so the operator can check it with the customer.
async function knownSources(supabase, job, source, userEdited) {
  const [{ data: qs }, { data: mats }] = await Promise.all([
    supabase.from('job_questions').select('answer_body, status').eq('job_id', job.id),
    supabase.from('job_materials').select('extracted_masked_text, status').eq('job_id', job.id).eq('kind', 'file'),
  ])
  const b = job.brief || {}
  const texts = [JSON.stringify(b.topResults || []), b.keepAvoid, b.story, b.notes, ...(qs || []).filter(q => q.status === 'answered').map(q => q.answer_body), ...(mats || []).filter(m => m.status === 'ready').map(m => m.extracted_masked_text)].filter(Boolean)
  return [source && source.body, userEdited, ...texts].filter(Boolean)
}

async function buildReview(env, supabase, jobId, operatorId) {
  const { data: job, error } = await supabase.from('human_jobs').select('*').eq('id', jobId).maybeSingle()
  if (error) throw error
  if (!job) return { ok: false, code: 'NOT_FOUND' }
  if (!['in_review', 'delivered', 'accepted', 'revision'].includes(job.state)) return { ok: false, code: 'NOT_REVIEWABLE', state: job.state }
  const [working, source, aiDraft] = await Promise.all([latestDoc(supabase, jobId, 'working'), latestDoc(supabase, jobId, 'source'), latestDoc(supabase, jobId, 'ai_draft')])
  if (!working) return { ok: false, code: 'NOTHING_SAVED' }
  await logView(supabase, operatorId, 'review_job_content', jobId, { state: job.state })
  let locked
  try { locked = await loadLocked(env, supabase, jobId) } catch (err) { if (err && err.code === 'LOCKED_VALUE_UNREADABLE') { console.error('[CRITICAL] humanDelivery:', err.message, 'job', jobId); return { ok: false, code: 'LOCKED_UNREADABLE' } } throw err }
  const base = aiDraft || source
  // only the lock markers the document the expert STARTED from carried can be missing: a field the customer's draft never had is not "lost"
  const required = base ? Object.keys(locks.markerCounts(base.body)).filter(k => k.startsWith('lock:')) : null
  const { data: resume, missing } = locks.restoreDocument(working.body, locked, { required })
  // a cover letter is delivered only when it was ordered
  const coverText = job.add_cover_letter && working.cover_letter && working.cover_letter.text ? locks.restoreDocument({ summary: working.cover_letter.text }, locked, { requireAll: false }) : null
  const { data: scanRow } = job.scan_id ? await supabase.from('scans').select('user_edited_resume_data').eq('id', job.scan_id).maybeSingle() : { data: null }
  const sources = await knownSources(supabase, job, source, scanRow && scanRow.user_edited_resume_data)
  const labelled = { ai_draft: aiDraft ? [aiDraft.body] : [], job_posting: job.brief && job.brief.jobPosting ? [job.brief.jobPosting] : [] }
  const figures = newFiguresDetailed(working.body, sources, [], labelled)
  const coverFigures = coverText ? newFiguresDetailed({ t: working.cover_letter.text }, sources, [], labelled) : []
  const details = [...new Map([...figures, ...coverFigures].map(f => [f.key, f])).values()].sort((x, y) => x.text.localeCompare(y.text))
  const { data: scan } = job.scan_id ? await supabase.from('scans').select('job_description_text').eq('id', job.scan_id).maybeSingle() : { data: null }
  const atsService = require('./ats.service'); const { serializeResumeData } = require('./resume.parser')
  let scoreAfter = null
  try { scoreAfter = atsService.scoreResume(serializeResumeData(resume), (scan && scan.job_description_text) || (job.brief && job.brief.jobPosting) || '').score } catch (err) { console.error('humanDelivery score:', err.message) }
  return { ok: true, job, resume, cover: coverText ? coverText.data.summary : null, missing: [...missing, ...(coverText ? coverText.missing : [])],
    newFigures: details.map(f => f.text), newFigureDetails: details.map(f => ({ text: f.text, origin: f.origin })), changes: diffDocuments(base && base.body, working.body), scoreBefore: job.score_before, scoreAfter, workingVersion: working.version }
}

const PDF_FAILED = 'PDF_FAILED'
async function buildFiles(env, supabase, job, review) {
  const docx = require('./docx.service'); const pdfTpl = require('./pdfTemplate.service'); const pdf = require('./pdf.service')
  let tokens = {}
  try { tokens = require('./design.service').getDesignTokens(job.customer_user_id, job.scan_id || job.id, 'default', { jdText: (job.brief && job.brief.jobPosting) || '' }) || {} } catch (_) { tokens = {} }
  const accent = tokens.palette && tokens.palette.primary
  const resumeDocx = await docx.generateAtsDocx(review.resume, null, { verified: false, accent })
  let resumePdf
  try { resumePdf = await pdf.generateResumePDF(env, pdfTpl.buildResumeHTML(review.resume, tokens, null, { verified: false })) }
  catch (err) { const e = new Error(`PDF build failed: ${err.message}`); e.code = PDF_FAILED; throw e }
  const coverDocx = review.cover ? await docx.generateCoverLetterDocx(review.cover, review.resume.name || '', { contact: null, accent }) : null
  return { resumeDocx, resumePdf, coverDocx }
}

async function deliver(env, supabase, jobId, operatorId, { note = '', summary = '', confirmed = [], overrideReason = '' } = {}) {
  const review = await buildReview(env, supabase, jobId, operatorId)
  if (!review.ok) return review
  const job = review.job
  if (job.state !== 'in_review') return { ok: false, code: 'NOT_IN_REVIEW', state: job.state }
  if (review.missing.length) return { ok: false, code: 'MARKERS_MISSING', missing: review.missing }
  const unconfirmed = review.newFigures.filter(f => !confirmed.includes(f))
  if (unconfirmed.length && !String(overrideReason).trim()) return { ok: false, code: 'UNCONFIRMED_FIGURES', figures: unconfirmed }
  const settings = await pilot.loadSettings(supabase); if (!settings) return { ok: false, code: 'NO_SETTINGS' }

  const ver = (job.revision_count || 0) + 1
  const prefix = `human/${jobId}/delivery-${ver}`
  let files
  try { files = await buildFiles(env, supabase, job, review) } catch (err) { return { ok: false, code: err.code === PDF_FAILED ? PDF_FAILED : 'BUILD_FAILED', message: err.message } }
  const keys = { docx: `${prefix}/resume.docx`, pdf: `${prefix}/resume.pdf` }
  await env.RESUMES_BUCKET.put(keys.docx, files.resumeDocx, { httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } })
  await env.RESUMES_BUCKET.put(keys.pdf, files.resumePdf, { httpMetadata: { contentType: 'application/pdf' } })
  if (files.coverDocx) { keys.cover = `${prefix}/cover-letter.docx`; await env.RESUMES_BUCKET.put(keys.cover, files.coverDocx, { httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }) }

  const confirmations = review.newFigures.map(f => ({ text: f, confirmed: confirmed.includes(f) }))
  const { data, error } = await supabase.rpc('human_job_deliver', { p_job: jobId, p_operator: operatorId || null, p_files: keys, p_score_before: Number.isInteger(review.scoreBefore) ? review.scoreBefore : null,
    p_score_after: Number.isInteger(review.scoreAfter) ? review.scoreAfter : null, p_report: { overrideReason: String(overrideReason || '').slice(0, 300) || null }, p_diff: review.changes, p_confirmations: confirmations,
    p_summary: String(summary || '').slice(0, 1000), p_note: String(note || '').slice(0, 1000), p_auto_hours: settings.accept_auto_hours })
  if (error) throw error
  if (!data.ok) { await env.RESUMES_BUCKET.delete(Object.values(keys)).catch(() => {}); return { ok: false, code: data.reason === 'not_in_review' ? 'NOT_IN_REVIEW' : 'DELIVER_FAILED' } }
  try {
    const { data: u } = await supabase.from('users').select('email, name').eq('id', job.customer_user_id).maybeSingle()
    if (u) await require('./email.service').sendHumanDelivered(env, supabase, u.email, u.name, { jobNumber: job.job_number, acceptHours: settings.accept_auto_hours })
  } catch (err) { console.error('humanDelivery notice:', err.message) }
  return { ok: true, deliveryVersion: data.delivery_version, scoreBefore: review.scoreBefore, scoreAfter: review.scoreAfter, files: Object.keys(keys) }
}

module.exports = { buildReview, deliver, logView, loadLocked, latestDoc, PDF_FAILED }
