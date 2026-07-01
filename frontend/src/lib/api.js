import axios from 'axios'

// Dev: Vite proxy handles /api → localhost:4000
// Prod: VITE_API_URL=https://api.passthrough.dev (Cloudflare Pages env)
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api'
})

api.interceptors.request.use(config => {
  const token = localStorage.getItem('passthrough_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  res => res,
  err => {
    const code   = err.response?.data?.code
    const status = err.response?.status
    if (status === 401 || code === 'SESSION_INVALID' || code === 'TOKEN_EXPIRED') {
      localStorage.removeItem('passthrough_token')
      localStorage.removeItem('passthrough_user')
      window.location.href = '/login?expired=true'
    }
    if (code === 'BANNED') {
      localStorage.removeItem('passthrough_token')
      localStorage.removeItem('passthrough_user')
      window.location.href = '/login?banned=true'
    }
    return Promise.reject(err)
  }
)

export default api
