// Say something to screen-reader users without showing it: one polite live region for the whole app, created on first use.
// Used for outcomes that only change a button's label ("Copied") — a label changing under someone is not announced by itself.
// It is a single node on <body> (not one per button): many live regions on a page is noisy for assistive tech, and a status
// region inside every button would collide with the page's own status messages. It carries aria-live but deliberately no
// role="status", so it never competes with the page's own role="status" / role="alert" elements.
let node = null
let flip = false
let clearTimer = null
let fillTimer = null

function region() {
  if (node && node.isConnected) return { el: node, fresh: false }
  node = document.createElement('div')
  node.setAttribute('aria-live', 'polite')
  node.setAttribute('aria-atomic', 'true')
  node.setAttribute('data-announcer', '')
  node.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0'
  document.body.appendChild(node)
  return { el: node, fresh: true }
}

export function announce(message) {
  if (typeof document === 'undefined' || !document.body || !message) return
  const { el, fresh } = region()
  // A region that is created and filled in the same tick is often not announced: fill a newly made one on the next tick.
  // The same text twice in a row (copy, wait, copy again) alternates a trailing no-break space so it is spoken again.
  flip = !flip
  const text = `${message}${flip ? ' ' : ''}`
  const put = () => { fillTimer = null; el.textContent = text }
  // A fill still waiting from the very first announcement must not land after (and over) this newer message.
  clearTimeout(fillTimer)
  fillTimer = null
  if (fresh) fillTimer = setTimeout(put, 50); else put()
  clearTimeout(clearTimer)
  clearTimer = setTimeout(() => { if (el.isConnected) el.textContent = '' }, 5000)
}
