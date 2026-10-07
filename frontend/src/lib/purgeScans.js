// "Delete scans" in batches, shared by Settings (the whole history) and the dashboard (just what
// the current search / status filter shows). The server removes a few dozen per call and says
// how many are left UNDER THE SAME FILTERS, so this loops with a running count instead of one
// request that has to finish a large history inside a single Worker call.
//
// Stops when nothing is left, or when a call deletes nothing (scans still being processed stay,
// so "remaining" can legitimately stay above zero). The cap is a seatbelt, not a limit anyone
// should reach.
//
// Resolves { deleted, remaining }. A failure part-way throws the original error with
// `purgeDeleted` set to how many had already gone, so the caller can say so truthfully.
export async function purgeScans(api, { status, search, onProgress, maxBatches = 400 } = {}) {
  const params = {}
  if (status) params.status = status
  if (search) params.search = search
  let deleted = 0
  let remaining = null
  try {
    for (let batch = 0; batch < maxBatches; batch++) {
      const res = await api.delete('/profile/scans', { params })
      const got = res.data.data
      deleted += got.deleted
      remaining = got.remaining
      onProgress?.(deleted)
      if (got.deleted === 0 || remaining === 0) break
    }
  } catch (err) {
    err.purgeDeleted = deleted
    throw err
  }
  return { deleted, remaining }
}

// "3 scans were deleted before it stopped." — or nothing when none had gone.
export function partialDeleteNote(deleted) {
  return deleted ? ` ${deleted} scan${deleted === 1 ? ' was' : 's were'} deleted before it stopped.` : ''
}
