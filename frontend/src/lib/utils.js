export function formatDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  })
}

// AUDIT FIX (Admin panel): accepts an optional currency, defaulting to
// 'USD' so every existing call site (which never passed one) renders
// byte-identical output to before. Needed because payouts/payments can
// carry a non-USD currency (recordPayoutSchema accepts any 3-letter code)
// — a bare `$${cents}` here would silently mislabel a KES or other
// non-USD amount as dollars, the same currency-mislabeling bug already
// fixed server-side for the partner list's roll-up totals.
export function formatCents(cents, currency = 'USD') {
  const amount = (cents / 100).toFixed(2)
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`
}

export function scoreColor(score) {
  if (score >= 75) return 'text-green-600'
  if (score >= 50) return 'text-amber-500'
  return 'text-red-600'
}

export function scoreBg(score) {
  if (score >= 75) return 'bg-green-50 border-green-200'
  if (score >= 50) return 'bg-amber-50 border-amber-200'
  return 'bg-red-50 border-red-200'
}

export function statusLabel(status) {
  const map = {
    PENDING:         'Pending',
    SCANNING:        'Scanning…',
    COMPLETE_PASS:   'Passed',
    COMPLETE_FAIL:   'Failed',
    FIX_PURCHASED:   'Fix purchased',
    FIX_GENERATING:  'Generating…',
    FIX_DELIVERED:   'Delivered',
    ERROR:           'Error'
  }
  return map[status] || status
}

export function cn(...classes) {
  return classes.filter(Boolean).join(' ')
}
