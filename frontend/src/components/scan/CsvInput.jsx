import { useState } from 'react'
import Input from '../ui/Input'

// AUDIT FIX (Auth/Scan round): the comma-separated skills/certifications/
// technologies fields displayed `(array || []).join(', ')` and re-split that
// on every keystroke. Typing "Go, " produced the array ['Go'] (the trailing
// empty token from the not-yet-typed next skill was filtered out), which
// immediately re-rendered the input back to "Go" via that same join —
// visibly eating the comma and space the person just typed, so only pasting
// a complete, already-finished list worked. This keeps the field's own text
// as local state — the source of truth for what's ON SCREEN while typing —
// and reports the parsed array to the parent on every change without ever
// reconstituting the input's value from that array.
export default function CsvInput({ value, onChange, ...props }) {
  const [text, setText] = useState((value || []).join(', '))
  return (
    <Input
      {...props}
      value={text}
      onChange={e => {
        const t = e.target.value
        setText(t)
        onChange(t.split(',').map(s => s.trim()).filter(Boolean))
      }}
    />
  )
}
