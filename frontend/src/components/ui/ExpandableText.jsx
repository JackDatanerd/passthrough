import { useId, useState } from 'react'

// A long piece of text shown as a short preview that opens on click. Used for customer stories, which run to 1200 characters: a
// list of them is scannable at a glance, and the whole story is one click away.
//
// Text at or under `limit` characters is shown whole, with no control. The cut is by character (code point), at a word boundary,
// so it never splits an emoji or a word and does not depend on layout.
//
// Uncontrolled by default. A caller that needs to KNOW whether the full text was opened (the admin review screen will not approve
// a story whose full text was never opened) passes `expanded` and `onToggle`.
export const PREVIEW_CHARS = 220

export function previewOf(text, limit = PREVIEW_CHARS) {
  const chars = Array.from(String(text ?? ''))
  if (chars.length <= limit) return { shown: chars.join(''), truncated: false }
  const cut = chars.slice(0, limit).join('')
  // Drop a trailing partial word, but only when the cut really fell inside one: when the next character is whitespace the last
  // word is complete and stays (cutting "aaaa bbbb cccc" at 9 gave "aaaa", losing a word that fit).
  const endsWord = /\s/.test(chars[limit])
  const atWord = endsWord ? cut : cut.replace(/\s+\S*$/, '')
  return { shown: (atWord || cut).replace(/\s+$/, ''), truncated: true }
}

export default function ExpandableText({
  text, limit = PREVIEW_CHARS, className = '',
  expanded: controlled, onToggle,
  moreLabel = 'Read full story', lessLabel = 'Show less',
}) {
  const id = useId()
  const [inner, setInner] = useState(false)
  const { shown, truncated } = previewOf(text, limit)
  if (!text) return null
  if (!truncated) return <p className={className}>{text}</p>

  const expanded = controlled !== undefined ? !!controlled : inner
  const toggle = () => {
    const next = !expanded
    if (controlled === undefined) setInner(next)
    if (onToggle) onToggle(next)
  }
  return (
    <div>
      <p id={id} className={className}>{expanded ? text : `${shown}…`}</p>
      <button type="button" aria-expanded={expanded} aria-controls={id} onClick={toggle}
        className="mt-1 text-sm text-blue-700 underline underline-offset-2 hover:text-blue-900">
        {expanded ? lessLabel : moreLabel}
      </button>
    </div>
  )
}
