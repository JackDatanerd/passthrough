import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { human, money } from '../../lib/humanApi'

// Experts Phase 1: the real "Human rewrite" option on the offer card.
//
// OFF BY DEFAULT AT BUILD TIME: unless the frontend is built with VITE_EXPERTS_ENABLED=true this renders nothing and makes NO request, so the
// offer card (and the network traffic of every page that shows it) is exactly what it was. When it is on, it asks the server whether the pilot
// is available for THIS account (the API answers 404 while EXPERTS_ENABLED is off there) and renders nothing unless it says yes.
export const EXPERTS_UI = import.meta.env.VITE_EXPERTS_ENABLED === 'true'

export default function HumanOrderEntry({ scanId }) {
  const [cfg, setCfg] = useState(null)
  useEffect(() => {
    let off = false
    if (!EXPERTS_UI || !scanId) return undefined
    Promise.resolve().then(() => human.config()).then(c => { if (!off) setCfg(c) }).catch(() => {})
    return () => { off = true }
  }, [scanId])
  if (!EXPERTS_UI || !cfg || !cfg.available || !scanId) return null
  const from = Math.min(...cfg.tiers.map(t => t.priceCents))
  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3 text-sm" data-testid="human-order-entry">
      <p className="font-medium text-gray-900">Want a person to rewrite it?</p>
      <p className="mt-1 text-gray-600">A vetted writer rewrites your resume with your contact details hidden. From {money(from)}. Codes apply to the AI Fix only.</p>
      <Link to={`/human/order?scanId=${encodeURIComponent(scanId)}`} className="mt-2 inline-block font-medium text-blue-700 hover:underline">Order a human rewrite {'\u2192'}</Link>
    </div>
  )
}

// A11 (G3): the way back into the orders page from the dashboard (it was reachable only from an email or the payment return). Same rules as
// the offer card: nothing is rendered and NO request is made unless the build flag is on, and it shows only for an account that has orders.
export function HumanOrdersLink() {
  const [n, setN] = useState(0)
  useEffect(() => {
    let off = false
    if (!EXPERTS_UI) return undefined
    Promise.resolve().then(() => human.list()).then(list => { if (!off) setN(Array.isArray(list) ? list.length : 0) }).catch(() => {})
    return () => { off = true }
  }, [])
  if (!EXPERTS_UI || n === 0) return null
  return <p className="text-sm" data-testid="human-orders-link"><Link to="/human/orders" className="font-medium text-blue-700 hover:underline">Your human rewrite orders ({n}) {'\u2192'}</Link></p>
}
