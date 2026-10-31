// A11: what the customer's return from Paystack means, decided from the answer of GET /payments/verify (the same endpoint the scan
// checkout uses). Plain data in, plain data out, so every outcome is testable without a screen. The old page treated ANY answer that was not an
// error as "paid" (a 202 {pending:true} included) and ANY error as "still confirming", so a declined card read as a delay.
//   paid | pending | refunded | disputed | support | failed | rate-limited | session | error
export function classifyVerify({ body, err } = {}) {
  if (body) {
    if (body.pending) return { kind: 'pending', message: body.message || '' }
    if (body.success === false) return { kind: 'failed', message: body.message || 'This payment was not completed.' }
    const d = body.data || {}
    if (d.refunded) return { kind: 'refunded', message: 'This payment has been refunded. If you did not expect that, contact support and quote your order number.' }
    if (d.disputed) return { kind: 'disputed', message: 'This payment is under a card dispute. We will email you.' }
    return { kind: 'paid', message: '' }
  }
  const status = err && err.response && err.response.status
  const data = (err && err.response && err.response.data) || {}
  if (status === 401) return { kind: 'session', message: 'Please sign in again. Your payment is safe either way.' }
  if (status === 409 && data.needsSupport) return { kind: 'support', message: data.message || 'Your payment was received but we could not attach it to your order. Please contact support and quote your order number.' }
  if (status === 429) return { kind: 'rate-limited', message: 'We are checking too often. We will try again in a moment.' }
  if (status === 400 || status === 404) return { kind: 'failed', message: data.message || 'This payment was not completed, so you have not been charged.' }
  return { kind: 'error', message: '' }
}

export const PENDING_MAX_ATTEMPTS = 8
export const PENDING_RETRY_MS = 4000
export const ERROR_RETRY_MS = 3000
export const ERROR_MAX_RETRIES = 2
export const RATE_RETRY_MS = 30000

// The states in which nothing is left to wait for: the orders page stops refreshing itself when every order is in one.
export const TERMINAL_STATES = ['accepted', 'cancelled', 'refunded']
