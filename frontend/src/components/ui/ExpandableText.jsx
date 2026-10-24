import { useId, useState } from 'react'

// A long piece of text shown as a short preview that opens on click. Used for customer stories, which run to 1200 characters: a
// list of them is scannable at a glance, and the whole story is one click away.
//
// Text at or under `limit` characters is shown whole, with no control. The cut is by character (code point), backed up to a whole emoji, at a word boundary,
// so it never splits an emoji or a word and does not depend on layout.
//
// Uncontrolled by default. A caller that needs to KNOW whether the full text was opened (the admin review screen will not approve
// a story whose full text was never opened) passes `expanded` and `onToggle`.
export const PREVIEW_CHARS = 220

// Round 27: the cut used to fall on any code point, which splits a multi-part emoji (a family, a flag, a skin-toned hand, a letter
// with its accent as a separate mark) when no space lies inside the limit: the preview then ended in a different emoji or a stray
// joiner. `limit` is still a budget of code points (so the preview never grows past it), but the cut now backs up to the edge of
// the last whole user-perceived character (Intl.Segmenter). A browser without it keeps the plain code-point cut.
let segmenter
function graphemes(text) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      segmenter = segmenter || new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      return Array.from(segmenter.segment(text), s => s.segment)
    } catch (_) { /* fall through */ }
  }
  return Array.from(text)
}

export function previewOf(text, limit = PREVIEW_CHARS) {
  const str = String(text ?? '')
  const points = Array.from(str)
  if (points.length <= limit) return { shown: str, truncated: false }
  const parts = graphemes(str)
  let used = 0
  let n = 0
  while (n < parts.length) {
    const size = Array.from(parts[n]).length
    if (used + size > limit) break
    used += size; n++
  }
  // One single character longer than the whole limit (cannot happen with real text): cut it by code point rather than show nothing.
  const cut = n > 0 ? parts.slice(0, n).join('') : points.slice(0, limit).join('')
  // Drop a trailing partial word, but only when the cut really fell inside one: when the next character is whitespace the last
  // word is complete and stays (cutting "aaaa bbbb cccc" at 9 gave "aaaa", losing a word that fit).
  const endsWord = /\s/.test(n > 0 ? parts[n] : points[limit])
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
