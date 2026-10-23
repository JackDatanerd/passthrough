import { forwardRef } from 'react'
import { useCopy } from '../../hooks/useCopy'
import { cn } from '../../lib/utils'
import { announce } from '../../lib/announce'
import Button from './Button'

// A "copy this to the clipboard" control, so every copy button in the app behaves the same way:
//   · the label turns into `copiedLabel` / `failedLabel` for `resetMs` (a refused clipboard write is reported, never
//     shown as "Copied");
//   · the outcome is ALSO announced (lib/announce.js, one shared live region). A button whose text changes under a screen-reader
//     user is not announced by itself, so "Copied" used to be a visual-only confirmation (and a failure often invisible too).
//   <CopyButton text={url} label="Copy link" />
//   <CopyButton text={() => buildHtml()} label="Copy HTML" variant="link" className="text-xs ..." />
// `text` may be a function, evaluated on click (for a value that is expensive or only valid at that moment).
// variant: any <Button> variant, or 'link' for the bare text-button style the inline copy links use (pass className).
const CopyButton = forwardRef(function CopyButton({
  text, label = 'Copy', copiedLabel = 'Copied', failedLabel = 'Copy failed',
  variant = 'secondary', size = 'sm', resetMs = 2000, className, onClick, onCopied, children, ...props
}, ref) {
  const { copied, failed, copy } = useCopy(resetMs)

  async function handleClick(e) {
    onClick?.(e)
    if (e?.defaultPrevented) return
    const value = typeof text === 'function' ? text() : text
    const ok = await copy(value)
    // Nothing to copy is not the browser's fault (a value that has not loaded yet).
    const empty = !(typeof value === 'number' || (typeof value === 'string' && value !== ''))
    announce(ok ? 'Copied to the clipboard.' : empty ? 'Nothing to copy yet.' : 'Could not copy — your browser blocked clipboard access.')
    if (ok) onCopied?.()
  }

  const shown = copied ? copiedLabel : failed ? failedLabel : (children ?? label)
  return variant === 'link'
    ? <button ref={ref} type="button" onClick={handleClick} className={cn(className)} {...props}>{shown}</button>
    : <Button ref={ref} variant={variant} size={size} onClick={handleClick} className={className} {...props}>{shown}</Button>
})

export default CopyButton
