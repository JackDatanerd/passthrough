import { describe, it, expect, vi } from 'vitest'
import { purgeScans, partialDeleteNote } from '../src/lib/purgeScans.js'
import { exportCursorFrom } from '../src/lib/dataExport.js'

const reply = (deleted, remaining) => ({ data: { data: { deleted, remaining } } })

describe('purgeScans', () => {
  it('loops batch by batch until nothing remains, reporting progress', async () => {
    const api = { delete: vi.fn().mockResolvedValueOnce(reply(25, 30)).mockResolvedValueOnce(reply(25, 5)).mockResolvedValueOnce(reply(5, 0)) }
    const seen = []
    expect(await purgeScans(api, { onProgress: n => seen.push(n) })).toEqual({ deleted: 55, remaining: 0 })
    expect(seen).toEqual([25, 50, 55])
    expect(api.delete).toHaveBeenCalledTimes(3)
  })
  it('sends the dashboard filters as query params, and none when there are none', async () => {
    const api = { delete: vi.fn().mockResolvedValue(reply(1, 0)) }
    await purgeScans(api, { status: 'ERROR', search: 'pm' })
    expect(api.delete).toHaveBeenLastCalledWith('/profile/scans', { params: { status: 'ERROR', search: 'pm' } })
    await purgeScans(api, {})
    expect(api.delete).toHaveBeenLastCalledWith('/profile/scans', { params: {} })
  })
  it('stops when a call deletes nothing (scans still in flight stay), leaving remaining > 0', async () => {
    const api = { delete: vi.fn().mockResolvedValueOnce(reply(3, 2)).mockResolvedValueOnce(reply(0, 2)) }
    expect(await purgeScans(api)).toEqual({ deleted: 3, remaining: 2 })
    expect(api.delete).toHaveBeenCalledTimes(2)
  })
  it('a failure part-way rethrows the ORIGINAL error carrying how many had already gone', async () => {
    const boom = { response: { status: 429 } }
    const api = { delete: vi.fn().mockResolvedValueOnce(reply(25, 40)).mockRejectedValueOnce(boom) }
    await expect(purgeScans(api)).rejects.toBe(boom)
    expect(boom.purgeDeleted).toBe(25)
  })
  it('the batch cap is a seatbelt that ends the loop', async () => {
    const api = { delete: vi.fn().mockResolvedValue(reply(1, 99)) }
    expect(await purgeScans(api, { maxBatches: 3 })).toEqual({ deleted: 3, remaining: 99 })
  })
})

describe('partialDeleteNote', () => {
  it('says nothing when nothing had been deleted; pluralizes otherwise', () => {
    expect(partialDeleteNote(0)).toBe('')
    expect(partialDeleteNote(undefined)).toBe('')
    expect(partialDeleteNote(1)).toBe(' 1 scan was deleted before it stopped.')
    expect(partialDeleteNote(25)).toBe(' 25 scans were deleted before it stopped.')
  })
})

describe('exportCursorFrom', () => {
  it('reads the keyset cursor header (axios lower-cases names)', () => {
    expect(exportCursorFrom({ headers: { 'x-export-cursor': '2026-10-01T00:00:00+00:00|abc' } })).toBe('2026-10-01T00:00:00+00:00|abc')
  })
  it('is null when absent or malformed — the part then pages by offset', () => {
    expect(exportCursorFrom({ headers: {} })).toBeNull()
    expect(exportCursorFrom({ headers: { 'x-export-cursor': 'nopipe' } })).toBeNull()
    expect(exportCursorFrom(undefined)).toBeNull()
  })
})
