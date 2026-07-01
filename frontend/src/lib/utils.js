export function formatDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  })
}

export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`
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
