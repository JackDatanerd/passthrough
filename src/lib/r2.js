// R2 bulk deletion shared by every flow that removes a user's stored files.
//
// R2's delete() accepts a LIST of keys (up to 1000) in ONE call, and each call is one subrequest. A
// per-key loop made an account with a few dozen scans (up to 3 objects each) cost over a hundred
// sequential round trips — slow enough to outlive the client's 30s timeout, and past the Free plan's
// 50-subrequest ceiling. A failed bulk call falls back to key-by-key so one bad object cannot spare
// the rest. Never throws; returns the keys that could not be removed so the caller can log them.

const R2_BATCH = 1000

async function deleteObjects(env, keys, label = 'r2') {
  const unique = [...new Set((keys || []).filter(k => typeof k === 'string' && k))]
  const failed = []
  if (!unique.length || !env || !env.RESUMES_BUCKET) return { deleted: 0, failed }
  for (let i = 0; i < unique.length; i += R2_BATCH) {
    const batch = unique.slice(i, i + R2_BATCH)
    try { await env.RESUMES_BUCKET.delete(batch); continue }
    catch (e) { console.error(`${label}: bulk R2 delete of ${batch.length} object(s) failed, retrying one by one:`, e && e.message) }
    for (const key of batch) {
      try { await env.RESUMES_BUCKET.delete(key) }
      catch (e) { failed.push(key); console.error(`${label}: failed to delete R2 object ${key}:`, e && e.message) }
    }
  }
  return { deleted: unique.length - failed.length, failed }
}

module.exports = { deleteObjects, R2_BATCH }
