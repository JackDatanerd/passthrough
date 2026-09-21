// Resolves the API base URL from the VITE_API_URL build-time variable.
//
// Every Worker route is mounted under /api (see src/index.js), and the Vite
// dev proxy forwards "/api" as-is. DEPLOYMENT.md used to tell people to set
// VITE_API_URL=https://api.passthrough.dev — WITHOUT the /api suffix — which
// makes every production request go to https://api.passthrough.dev/auth/login
// (404) instead of .../api/auth/login. Rather than rely on the deployer
// getting the suffix right, normalise it: either spelling now works.
export function resolveApiBase(envUrl) {
  const raw = typeof envUrl === 'string' ? envUrl.trim() : ''
  if (!raw) return '/api'
  const noTrailing = raw.replace(/\/+$/, '')
  return /\/api$/i.test(noTrailing) ? noTrailing : `${noTrailing}/api`
}
