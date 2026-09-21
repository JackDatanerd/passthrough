#!/usr/bin/env node
// Zero-config "no-undef" + syntax gate for every JS/JSX file in the repo.
//
// Why this exists: webhooks.controller.js once contained a bare `fix_tier,`
// object-shorthand where the variable in scope was `fixTier`. That is a
// ReferenceError at runtime, on the code path that fulfils most real payments —
// and nothing in the repo could see it: the tests didn't cover that file and there
// was no linter. This uses TypeScript's checker purely to report *undefined
// identifiers* and *syntax errors* (it ignores type errors), so it needs no
// config and no new dependency in package.json / package-lock.json:
//
//   npm run lint                       (uses `typescript` if it is installed)
//   npm i --no-save typescript && npm run lint
//
// CI installs typescript with --no-save and fails the build on any finding.
// Locally, if typescript isn't installed the script says so and exits 0 —
// unless CI=true, where a missing checker is itself a failure.
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const DIRS = ['src', 'tests', 'frontend/src', 'frontend/tests', 'frontend/functions', 'supabase', 'scripts']
// Runtime globals ESLint's "env" would normally provide.
const ALLOWED = new Set(['require', 'module', 'exports', 'process', '__dirname', '__filename', 'Buffer', 'HTMLRewriter'])

let ts
try { ts = require('typescript') } catch (_) {
  const msg = 'lint-undefined: `typescript` is not installed, so nothing was checked. Run: npm i --no-save typescript'
  if (process.env.CI) { console.error(msg); process.exit(1) }
  console.warn(msg); process.exit(0)
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.wrangler', '.git'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(m?js|jsx|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = DIRS.flatMap(d => walk(path.join(ROOT, d)))
const program = ts.createProgram(files, {
  allowJs: true, checkJs: true, noEmit: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
  strict: false, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: [],
})

let problems = 0
for (const sf of program.getSourceFiles()) {
  if (!files.includes(sf.fileName)) continue
  for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
    // 2304/2552: "Cannot find name X"; 18004: object shorthand with no such variable (the webhook bug).
    const m = /Cannot find name '([^']+)'/.exec(msg) || /shorthand property '([^']+)'/.exec(msg)
    const isUndef = m && [2304, 2552, 18004].includes(d.code) && !ALLOWED.has(m[1])
    const isSyntax = d.code < 2000 && d.code !== 18004
    if (!isUndef && !isSyntax) continue
    const { line } = sf.getLineAndCharacterOfPosition(d.start)
    console.error(`${isUndef ? 'UNDEFINED' : 'SYNTAX   '} ${path.relative(ROOT, sf.fileName)}:${line + 1}  ${isUndef ? `'${m[1]}'` : msg}`)
    problems++
  }
}
if (problems) { console.error(`\nlint-undefined: ${problems} problem(s)`); process.exit(1) }
console.log(`lint-undefined: ${files.length} files clean`)
