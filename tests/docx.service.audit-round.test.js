import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { generateAtsDocx, xmlSafe } from '../src/services/docx.service.js'

describe('generateAtsDocx — illegal XML characters (Auth/Scan round)', () => {
  it('strips control characters and lone surrogates so Word can open the file', async () => {
    const data = { name: 'Jane\u000b Doe', email: 'j@x.com', summary: 'Led\u000c team \u0000of 5 \uD800 and grew revenue',
      experience: [{ company: 'Acme\u0001', title: 'Eng', dates: '2019', bullets: ['Built\u000bthing'] }], skills: ['Go\u0000'] }
    const buf = await generateAtsDocx(data, null, { verified: false })
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string')
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)).toBe(false)
    expect(xml).toContain('Jane Doe')
    expect(xml).toContain('Led team of 5  and grew revenue')
  })
  it('keeps tabs/newlines, astral characters (emoji) and normal text untouched', () => {
    expect(xmlSafe('a\tb\nc 😀 é')).toBe('a\tb\nc 😀 é')
    expect(xmlSafe({ a: ['x\u0000', 1, null] })).toEqual({ a: ['x', 1, null] })
  })
})
