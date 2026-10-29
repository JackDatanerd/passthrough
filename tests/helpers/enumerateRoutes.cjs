// Lists EVERY route the app serves, by reading how src/index.js mounts its routers (so a new router cannot be missed: an unparsable mount line
// throws). Returns [{ method, path, prefix }] with params replaced by a placeholder. Used by the cross-realm and flag-off tests.
const fs = require('fs'); const path = require('path')
const SRC = path.resolve(__dirname, '../../src')
const PLACEHOLDER = '00000000-0000-4000-8000-0000000000aa'

function enumerateApp() {
  const index = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8')
  const requires = {}
  for (const m of index.matchAll(/const\s+(?:\{\s*([\w:\s,]+?)\s*\}|(\w+))\s*=\s*require\('\.\/routes\/([\w.-]+)'\)/g)) {
    if (m[2]) requires[m[2]] = { file: m[3] }
    else for (const part of m[1].split(',')) { const [exp, local] = part.split(':').map(s => s.trim()); requires[local || exp] = { file: m[3], exp } }
  }
  const mounts = [...index.matchAll(/^app\.route\('([^']+)',\s*(\w+)\)/gm)]
  const totalMountLines = (index.match(/^app\.route\(/gm) || []).length
  if (mounts.length !== totalMountLines) throw new Error('a mount line in src/index.js could not be parsed')
  const out = []
  for (const [, prefix, name] of mounts) {
    const r = requires[name]; if (!r) throw new Error(`mount ${prefix}: router ${name} is not a ./routes require`)
    const mod = require(path.join(SRC, 'routes', r.file)); const router = r.exp ? mod[r.exp] : mod
    for (const { method, path: p } of router.routes) {
      if (method === 'ALL' || p.includes('*')) continue
      const sub = p === '/' ? '' : p
      out.push({ method, prefix, path: `${prefix}${sub}`.replace(/:[A-Za-z_]+(\{[^}]*\})?\??/g, PLACEHOLDER) })
    }
  }
  for (const m of index.matchAll(/^app\.(get|post)\('(\/[^']*)'/gm)) out.push({ method: m[1].toUpperCase(), prefix: '', path: m[2] })
  const seen = new Set(); return out.filter(r => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true })
}
module.exports = { enumerateApp, PLACEHOLDER }
