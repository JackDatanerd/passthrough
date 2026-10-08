import { describe, it, expect } from 'vitest'
import { parseCsv, leadRowsFromCsv, chunk, IMPORT_MAX_ROWS } from '../src/lib/leadImport.js'

describe('parseCsv', () => {
  it('handles quotes, embedded commas, doubled quotes, embedded newlines, CRLF and a BOM', () => {
    const t = parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",z\r\n')
    expect(t).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['line1\nline2', 'z']])
  })
  it('detects semicolon and tab delimiters from the header line', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('skips blank lines and keeps a last row with no trailing newline', () => {
    expect(parseCsv('a,b\n\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })
})

describe('leadRowsFromCsv', () => {
  it('maps header aliases in any order and case', () => {
    const { rows, error } = leadRowsFromCsv('Email Address,Full Name,Organisation,Job Title,Role Category,Comments\nA@b.com,Ann,Acme,Lead,Sales,met at conf')
    expect(error).toBeNull()
    expect(rows).toEqual([{ name: 'Ann', company: 'Acme', email: 'A@b.com', field: 'Sales', role: 'Lead', notes: 'met at conf' }])
  })
  it('optional columns may be absent', () => {
    expect(leadRowsFromCsv('name,company,email\nAnn,Acme,a@b.com').rows[0]).toMatchObject({ field: '', role: '', notes: '' })
  })
  it('says which required column is missing, and when there is nothing to import', () => {
    expect(leadRowsFromCsv('name,email\nAnn,a@b.com').error).toMatch(/company/)
    expect(leadRowsFromCsv('name,company,email').error).toMatch(/at least one lead/)
    expect(leadRowsFromCsv('').error).toBeTruthy()
  })
  it('refuses a file over the row limit', () => {
    const body = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `n${i},c,e${i}@x.com`).join('\n')
    expect(leadRowsFromCsv('name,company,email\n' + body).error).toMatch(/At most/)
  })
})

describe('chunk', () => {
  it('splits into batches', () => { expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]) })
})
