// Experts Phase 1: the EXPERT realm's API client. A separate axios instance with its own token in sessionStorage under its own key: it never
// reads the customer's session, and the customer's session never reads it. (Expert pages are a lazy chunk of this app for the pilot; the
// engineering spec splits them into their own site in Phase 2.)
import axios from 'axios'
import { resolveApiBase } from './apiUrl'

export const EXPERT_TOKEN_KEY = 'pt_expert_token'
const store = { get: () => { try { return sessionStorage.getItem(EXPERT_TOKEN_KEY) } catch (_) { return null } }, set: v => { try { v ? sessionStorage.setItem(EXPERT_TOKEN_KEY, v) : sessionStorage.removeItem(EXPERT_TOKEN_KEY) } catch (_) {} } }
const ex = axios.create({ baseURL: `${resolveApiBase(import.meta.env.VITE_API_URL)}/expert`, timeout: 30_000 })
ex.interceptors.request.use(cfg => { const t = store.get(); if (t) cfg.headers.Authorization = `Bearer ${t}`; return cfg })

export const expert = {
  token: store, // { get, set }
  login: (email, password) => ex.post('/auth/login', { email, password }).then(r => r.data.data),
  enrollStart: () => ex.post('/auth/enroll/start').then(r => r.data.data),
  mfa: code => ex.post('/auth/mfa', { code }).then(r => r.data.data),
  logout: () => ex.post('/auth/logout').then(() => store.set(null)),
  me: () => ex.get('/me').then(r => r.data.data),
  earnings: () => ex.get('/earnings').then(r => r.data.data),
  jobs: () => ex.get('/jobs').then(r => r.data.data.jobs),
  job: id => ex.get(`/jobs/${id}`).then(r => r.data.data),
  save: (id, payload) => ex.put(`/jobs/${id}/document`, payload).then(r => r.data.data),
  ask: (id, body) => ex.post(`/jobs/${id}/questions`, { body }).then(r => r.data.data),
  submit: id => ex.post(`/jobs/${id}/submit`).then(r => r.data),
}
