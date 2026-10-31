// Experts Phase 1: the customer's calls to /api/human/*. Uses the app's own api client (the customer's normal session).
import api from './api'

export const human = {
  config: () => api.get('/human/config').then(r => r.data.data),
  create: body => api.post('/human/orders', body).then(r => r.data.data),
  list: () => api.get('/human/orders').then(r => r.data.data.orders),
  get: id => api.get(`/human/orders/${id}`).then(r => r.data.data),
  pay: id => api.post(`/human/orders/${id}/pay`).then(r => r.data.data),
  structure: scanId => api.post(`/scan/${scanId}/structure`).then(r => r.data),
  verify: reference => api.get(`/payments/verify?reference=${encodeURIComponent(reference)}`).then(r => r.data),
  answer: (id, qid, answer) => api.post(`/human/orders/${id}/questions/${qid}`, { answer }),
  accept: id => api.post(`/human/orders/${id}/accept`),
  revision: (id, reason) => api.post(`/human/orders/${id}/revision`, { reason }),
  rate: (id, stars) => api.post(`/human/orders/${id}/rate`, { stars }),
  cancel: id => api.post(`/human/orders/${id}/cancel`),
  addLink: (id, url) => api.post(`/human/orders/${id}/links`, { url }),
  removeMaterial: (id, mid) => api.delete(`/human/orders/${id}/materials/${mid}`),
  upload: (id, file) => { const f = new FormData(); f.append('file', file); return api.post(`/human/orders/${id}/materials`, f, { headers: { 'Content-Type': 'multipart/form-data' } }) },
  downloadUrl: (id, kind) => `${api.defaults.baseURL}/human/orders/${id}/files/${kind}`,
  download: async (id, kind) => {
    const r = await api.get(`/human/orders/${id}/files/${kind}`, { responseType: 'blob' })
    const url = URL.createObjectURL(r.data); const a = document.createElement('a'); a.href = url; a.download = `${kind === 'cover' ? 'cover-letter' : 'resume'}.${kind === 'pdf' ? 'pdf' : 'docx'}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000)
  },
}
export const money = cents => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`
