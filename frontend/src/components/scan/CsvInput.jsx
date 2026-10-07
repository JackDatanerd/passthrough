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
//
// BUG FIX (resume-from-scratch pass): local state meant the field never noticed when the parent
// handed it a DIFFERENT list. Rows in the editor are keyed by position, so removing project 1 of 2
// left project 2 in the same slot still showing project 1's technologies (the saved data was right,
// the screen was wrong, and the next keystroke would overwrite the data with what was on screen).
// When the incoming list stops matching what the field's own text parses to, the text is reset to it.
const parse = t => t.split(',').map(s => s.trim()).filter(Boolean)
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

export default function CsvInput({ value, onChange, ...props }) {
  const incoming = Array.isArray(value) ? value : []
  const [text, setText] = useState(incoming.join(', '))
  let shown = text
  if (!same(parse(text), incoming)) {
    shown = incoming.join(', ')
    setText(shown)
  }
  return (
    <Input
      {...props}
      value={shown}
      onChange={e => {
        const t = e.target.value
        setText(t)
        onChange(parse(t))
      }}
    />
  )
}
