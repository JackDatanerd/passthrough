import Select from '../ui/Select'

// Page size for the delivered documents (resume .docx and .pdf, cover letter). Scan/ATS round 12: it used to be guessed from
// the job posting alone, with no way to correct a wrong guess - a US posting that mentions a UK office printed on A4, an
// applicant in Nairobi sending to a firm that names no country got Letter. '' means "Auto": the posting decides, as before.
export const PAPER_OPTIONS = [
  { value: '',       label: 'Automatic (from the job posting)' },
  { value: 'letter', label: 'US Letter (8.5 × 11 in) - US and Canada' },
  { value: 'a4',     label: 'A4 (210 × 297 mm) - UK, Europe, Africa and most of the world' },
]

export default function PaperSizeSelect({ value, onChange, disabled = false, hint, className }) {
  return (
    <Select
      label="Page size for your documents"
      hint={hint === undefined ? 'Used for the resume and cover letter files. Automatic reads it from the job posting.' : hint}
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      wrapperClassName={className}
      data-testid="paper-size"
    >
      {PAPER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  )
}
