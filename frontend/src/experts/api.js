// Experts Phase 2A: the expert site's API client. Same origin (/api on experts.usepassthrough.com); the session is an HttpOnly cookie the browser
// attaches by itself, so this code never holds, stores or sends a credential. The customer
// site's api.js and token are not imported here.
import axios from 'axios'

const http = axios.create({ baseURL: '/api', timeout: 30_000, withCredentials: true })
const data = r => r.data.data
const R = '/expert-realm', A = '/expert-admin'

export const errorCode = err => (err && err.response && err.response.data && err.response.data.code) || null
export const errorMessage = (err, fallback = 'Something went wrong. Please try again.') => (err && err.response && err.response.data && err.response.data.message) || fallback

export const realm = {
  login: (email, password) => http.post(`${R}/auth/login`, { email, password }).then(data),
  totpSetup: () => http.post(`${R}/auth/totp/setup`).then(data),
  totp: code => http.post(`${R}/auth/totp`, { code }).then(data),
  recover: code => http.post(`${R}/auth/recover`, { code }).then(data),
  me: () => http.get(`${R}/me`).then(data),
  logout: () => http.post(`${R}/auth/logout`).then(() => null),
  logoutAll: () => http.post(`${R}/auth/logout-all`).then(() => null),
  sessions: () => http.get(`${R}/sessions`).then(r => r.data.data.sessions),
  endSession: id => http.delete(`${R}/sessions/${encodeURIComponent(id)}`).then(() => null),
  stepUp: password => http.post(`${R}/auth/step-up`, { password }).then(data),
  changePassword: (current, next) => http.post(`${R}/me/password`, { current, next }).then(data),
  newRecoveryCodes: () => http.post(`${R}/me/recovery-codes`).then(data),
  forgot: email => http.post(`${R}/auth/password/forgot`, { email }).then(data),
  reset: (token, password) => http.post(`${R}/auth/password/reset`, { token, password }).then(data),
  desk: () => http.get(`${R}/desk`).then(r => r.data.data.jobs),
}
export const admin = {
  board: state => http.get(`${A}/board`, { params: state ? { state } : {} }).then(r => r.data.data.jobs),
  job: id => http.get(`${A}/jobs/${encodeURIComponent(id)}`).then(data),
  assign: (id, expertId, reason) => http.post(`${A}/jobs/${encodeURIComponent(id)}/assign`, { expertId, reason }).then(data),
  reassign: (id, expertId, reason) => http.post(`${A}/jobs/${encodeURIComponent(id)}/reassign`, { expertId, reason }).then(data),
  refund: (id, { reason, amountCents, idemKey }) => http.post(`${A}/jobs/${encodeURIComponent(id)}/refund`, { reason, idemKey, ...(amountCents ? { amountCents } : {}) }).then(data),
  experts: () => http.get(`${A}/experts`).then(r => r.data.data.experts),
  audit: params => http.get(`${A}/audit`, { params }).then(data),
}
