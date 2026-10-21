import { Children, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

// Inline notice box. The red "something failed" box was hand-written, with
// slightly different borders, radii and text colours, in ScanForm, Login,
// ResumeDataEditor, SavedProfileEditor, dashboard/Index, ScanResult (twice) and
// PartnerDetail. One component keeps them identical and gives every one the
// right live-region role: errors are announced assertively, the rest politely.
const variants = {
  error:   'bg-red-50 border-red-200 text-red-800',
  warning: 'bg-amber-50 border-amber-200 text-amber-800',
  success: 'bg-green-50 border-green-200 text-green-800',
  info:    'bg-blue-50 border-blue-200 text-blue-800',
}

// cn() only concatenates, and when two Tailwind text sizes are present the one defined LATER in the
// stylesheet wins (text-sm beats text-xs), not the one passed last — so `<Alert className="text-xs">`
// was silently ignored. The default size is dropped when the caller supplies their own.
const TEXT_SIZE = /(?:^|\s)text-(?:xs|sm|base|lg|xl|2xl)(?:\s|$)/

// `focusOnShow`: for the message a FAILED SUBMIT leaves behind. role="alert" makes a screen reader speak it, but focus stayed
// on the button that was pressed, so a keyboard user on a long form was never taken to the message (and a sighted one could have it
// below the fold). With this the box takes focus (and scrolls into view) each time it goes from empty to showing a message —
// clear the message when the next attempt starts and a repeat of the same text is brought into view again.
export default function Alert({ variant = 'error', className, children, focusOnShow = false, ...props }) {
  // Several children that are ALL empty ({a}{b} with both falsy) used to draw an empty bordered box.
  // Round 23: a numeric 0 is empty too — `{count && <x/>}` with count = 0 drew a red box holding just "0".
  const empty = !Children.toArray(children).some(c => c !== '' && c !== 0)
  const ref = useRef(null)
  useEffect(() => {
    if (focusOnShow && !empty) ref.current?.focus()
  }, [focusOnShow, empty])
  // Round 21: a role="status" node that is inserted already holding its text is often NOT spoken (see OfflineBanner), so a "Saved" /
  // warning / info notice that appears after an action was silent for many screen-reader users. role="alert" (the error variant) is
  // special-cased by assistive tech and needs nothing. For the others the live region goes into the page EMPTY first and gets its
  // message in the effect that follows, so the text arrives as a change to a region that already exists. (Content is in the DOM by
  // the time any test or caller looks: the effect flushes inside the same act / tick.)
  const live = variant !== 'error'
  const [filled, setFilled] = useState(!live)
  useEffect(() => { setFilled(!live || !empty) }, [live, empty])
  if (!empty && live && !filled) return <div ref={ref} role="status" {...(focusOnShow ? { tabIndex: -1 } : {})} />
  if (empty) return null
  return (
    <div
      ref={ref}
      role={variant === 'error' ? 'alert' : 'status'}
      {...(focusOnShow ? { tabIndex: -1 } : {})}
      className={cn('rounded-md border px-3 py-2', !TEXT_SIZE.test(className || '') && 'text-sm', variants[variant] || variants.error, focusOnShow && 'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', className)}
      {...props}
    >
      {children}
    </div>
  )
}
