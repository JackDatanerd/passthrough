import { describe, it, expect } from 'vitest'
import { csvCell, csvText, toCsv } from '../src/lib/utils'

// Section 4 round 6: the payout-run CSV is for PAYING people. A mobile-money number must not gain an apostrophe,
// a bank account must keep its leading zero, and nothing partner-controlled may become a formula.
describe('csvText', () => {
  it('writes a +country-code phone number as Excel text, with no literal apostrophe', () => {
    expect(csvCell(csvText('+254 712 345 678'))).toBe('"=""+254 712 345 678"""')
  })
  it('keeps the leading zero of a bank account', () => {
    expect(csvCell(csvText('0012345678'))).toBe('"=""0012345678"""')
  })
  it('an IBAN (starts with letters) and a number that could parse as scientific notation are both safe', () => {
    expect(csvCell(csvText('GB29NWBK60161331926819'))).toBe('GB29NWBK60161331926819')
    expect(csvCell(csvText('12345E10'))).toBe('"=""12345E10"""')
  })
  it('a value that could carry a formula falls back to the normal neutralising rules', () => {
    expect(csvCell(csvText('=1+1'))).toBe("'=1+1")
    expect(csvCell(csvText('+1,2'))).toBe('"\'+1,2"')
    expect(csvCell(csvText('-4455"x'))).toBe('"\'-4455""x"')
    expect(csvCell(csvText('@SUM(A1)'))).toBe("'@SUM(A1)")
  })
  it('empty / null stay empty', () => {
    expect(csvCell(csvText(''))).toBe('')
    expect(csvCell(csvText(null))).toBe('')
  })
  it('plain text cells keep the apostrophe rule (the regression this must not break)', () => {
    expect(csvCell('+254 712')).toBe("'+254 712")
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"')
    expect(csvCell(-5)).toBe('-5')
  })
  it('works inside a row', () => {
    expect(toCsv([['Ann', csvText('+254700000000'), '12.00']])).toBe('Ann,"=""+254700000000""",12.00')
  })
})
