// Loads a CommonJS module from src/ with some of ITS dependencies replaced by
// stubs — without touching production code. src/ modules call require()
// internally, which vitest's vi.mock() cannot intercept, so this seeds Node's
// require.cache for the stubbed modules instead.
//
//   const { mod, restore } = loadWithStubs('controllers/webhooks.controller.js', {
//     'config/supabase.js': { getSupabase: () => fakeDb },
//     'services/email.service.js': { sendOwnerAlert: async () => {} },
//   })
//   ...
//   afterEach(restore)
//
// Stub keys are normally paths relative to src/. A key that doesn't resolve
// there (no src/<key>.js on disk) is instead resolved as a plain package
// specifier via Node's own require resolution — e.g. '@cloudflare/puppeteer'
// for pdf.service.js, which requires it directly, same as any src/ path.
const fs = require('fs')
const path = require('path')
const SRC = path.resolve(__dirname, '../../src')

function resolveStubTarget(rel) {
  const asSrcPath = path.join(SRC, rel)
  if (fs.existsSync(asSrcPath) || fs.existsSync(`${asSrcPath}.js`)) return require.resolve(asSrcPath)
  return require.resolve(rel)
}

function loadWithStubs(targetRel, stubs = {}) {
  const stubbed = []
  for (const [rel, exports] of Object.entries(stubs)) {
    const p = resolveStubTarget(rel)
    stubbed.push(p)
    require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] }
  }
  const target = require.resolve(path.join(SRC, targetRel))
  delete require.cache[target]
  const mod = require(target)
  return {
    mod,
    restore() {
      stubbed.forEach(p => delete require.cache[p])
      delete require.cache[target]
    },
  }
}

module.exports = { loadWithStubs, SRC }
