import { useRef, useState } from 'react'
import { cn } from '../../lib/utils'

// Shared "n/limit" counter for Input and Textarea (`showCount` + `maxLength`).
//
// Why it exists: ~30 fields cap their length with `maxLength`, and browsers cut a PASTED over-long text at the limit without
// a word — someone pasting a 1,500-character pitch into a 1,000-character box lost the tail and never knew. The counter shows
// how much room is left, and when a paste was cut it says so (visibly, and to screen readers through the status region).
//
// Counts UTF-16 code units, which is exactly what the native `maxLength` counts, so the number always matches the cap.
// Works controlled (`value`) or uncontrolled (`defaultValue`, tracked from change events).
//
// Screen readers: the visible "n/limit" is aria-hidden (a number changing on every keystroke would be noise). A polite status
// region only says something at two thresholds ("approaching", "reached") and when a paste was cut — each a fixed string, so it
// is not re-announced per keystroke.
const NEAR = 0.9

export function useCharCount({ enabled, maxLength, value, defaultValue, onChange, onPaste, onBlur }) {
  const max = Number(maxLength)
  const on = !!enabled && Number.isFinite(max) && max > 0
  const [typed, setTyped] = useState(() => String(defaultValue ?? '').length)
  const [cut, setCut] = useState(0)
  const keepCut = useRef(false)   // the change event that follows a paste must not clear the paste notice

  if (!on) return { handlers: { onChange, onPaste, onBlur }, counter: null }

  const length = value !== undefined ? String(value ?? '').length : typed
  const handlers = {
    onChange: e => {
      if (value === undefined) setTyped(e.target.value.length)
      if (keepCut.current) keepCut.current = false
      else setCut(0)
      onChange?.(e)
    },
    onPaste: e => {
      onPaste?.(e)
      if (e.defaultPrevented) return
      const t = e.target
      let text = e.clipboardData?.getData?.('text') ?? ''
      // Clipboards (Windows above all) carry CRLF, but a field counts a line break as ONE character; counting the \r as well
      // reported a paste that fit exactly as "cut", and overstated every real cut by the number of line breaks.
      text = text.replace(/\r\n?/g, '\n')
      if (t.tagName === 'INPUT') text = text.replace(/\n/g, '')   // a single-line input drops line breaks on paste
      const replaced = (t.selectionEnd ?? 0) - (t.selectionStart ?? 0)
      const lost = String(t.value ?? '').length - replaced + text.length - max
      if (lost > 0) {
        keepCut.current = true; setCut(lost)
        // The change event of a paste fires in the same task. A paste the browser swallowed whole (a field that is already
        // full) fires none, and the flag used to survive to the NEXT edit, which then left the notice up.
        setTimeout(() => { keepCut.current = false }, 0)
      }
    },
    onBlur: e => { keepCut.current = false; setCut(0); onBlur?.(e) },
  }

  const full = length >= max
  const near = length >= Math.ceil(max * NEAR)
  const status = cut
    ? `Pasted text was cut by ${cut} character${cut === 1 ? '' : 's'} to fit the ${max}-character limit.`
    : full ? 'Character limit reached' : near ? 'Approaching the character limit' : ''

  const counter = (
    <div className="shrink-0 text-right text-xs">
      <span aria-hidden="true" className={cn('tabular-nums', full ? 'font-medium text-red-600' : near ? 'text-amber-700' : 'text-gray-500')}>
        {length}/{max}
      </span>
      <span role="status" className={cut ? 'block text-amber-700' : 'sr-only'}>{status}</span>
    </div>
  )
  return { handlers, counter }
}

// Lays the hint/error text and the counter on one row; with no counter the text renders exactly as before.
export function FieldFooter({ counter, children }) {
  if (!counter) return children
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">{children}</div>
      {counter}
    </div>
  )
}
