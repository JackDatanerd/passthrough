import { useRef, useState } from 'react'
import Input from '../ui/Input'

// A comma-separated field for a list of short items (skills, certifications, languages, technologies).
//
// The field's own text is the source of truth for what is ON SCREEN while typing, and the parsed list is reported up on every
// change. It must never rebuild the text from the list the parent hands back: typing "Go, " would turn into "Go" and eat the comma.
// But it must notice when the parent hands it a DIFFERENT list (removing project 1 of 2 leaves project 2 in the same slot, still
// showing project 1's technologies), so the text is reset when the incoming list changes to something this field did not send.
//
// That check compares the incoming list with the one this field LAST SENT, and with the one it last SAW. It used to compare the
// incoming list with what the typed text parses to, which can never agree for an item that itself contains a comma ("Cloud (AWS,
// Azure)", "PMP, Project Management Institute"): the reset ran on every render, forever, and React gave up with "Too many
// re-renders" (the whole page was replaced by the error screen the moment such an editor opened).
const sig = v => JSON.stringify(v)
const clean = v => (Array.isArray(v) ? v : []).map(x => (typeof x === 'string' ? x : x == null ? '' : String(x))).filter(x => x.trim())

// Split on commas that are not inside brackets, so "Cloud (AWS, Azure), SQL" is two items, not three.
export function parseCsv(text) {
  const out = []
  let depth = 0, cur = ''
  for (const ch of String(text)) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

export default function CsvInput({ value, onChange, ...props }) {
  const incoming = clean(value)
  const key = sig(incoming)
  const [text, setText] = useState(incoming.join(', '))
  const [seen, setSeen] = useState(key)
  const sent = useRef(null)
  if (key !== seen) {
    // One state update per change of the incoming list (never one per render), so this cannot loop.
    setSeen(key)
    if (key !== sent.current) setText(incoming.join(', '))
  }
  return (
    <Input
      {...props}
      value={text}
      onChange={e => {
        const t = e.target.value
        const arr = parseCsv(t)
        sent.current = sig(arr)
        setText(t)
        onChange(arr)
      }}
    />
  )
}
