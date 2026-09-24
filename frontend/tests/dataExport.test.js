import { describe, it, expect } from 'vitest'
import { exportFileName, exportPartsFrom } from '../src/lib/dataExport.js'

const blobOf = (obj) => ({ text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) })

describe('exportFileName', () => {
  it('part 1 keeps the original name; later parts are numbered', () => {
    expect(exportFileName(1)).toBe('passthrough-my-data.json')
    expect(exportFileName(2)).toBe('passthrough-my-data-part-2.json')
    expect(exportFileName(12)).toBe('passthrough-my-data-part-12.json')
  })
})

describe('exportPartsFrom', () => {
  it('reads the X-Export-Parts header first (axios lower-cases header names)', async () => {
    expect(await exportPartsFrom({ headers: { 'x-export-parts': '3' }, data: blobOf({ export: { parts: 9 } }) })).toBe(3)
  })
  it('falls back to the file\'s own export.parts when the header is hidden', async () => {
    expect(await exportPartsFrom({ headers: {}, data: blobOf({ export: { parts: 4 } }) })).toBe(4)
  })
  it('is 1 for anything unreadable, never NaN or 0', async () => {
    expect(await exportPartsFrom({ headers: { 'x-export-parts': 'abc' }, data: blobOf('not json') })).toBe(1)
    expect(await exportPartsFrom({ headers: { 'x-export-parts': '0' }, data: blobOf({}) })).toBe(1)
    expect(await exportPartsFrom({ headers: {}, data: blobOf({ export: { parts: -2 } }) })).toBe(1)
    expect(await exportPartsFrom({})).toBe(1)
    expect(await exportPartsFrom(undefined)).toBe(1)
  })
})
