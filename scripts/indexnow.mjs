#!/usr/bin/env node
// Announces new or changed public pages to IndexNow (Bing, Yandex, Seznam, Naver, Yep) once their deploy is live.
// Run by .github/workflows/indexnow.yml on every push to main that touches frontend/; it exits quietly when the push
// changed no public page. Read frontend/seo/indexnow.js for the rules and DEPLOYMENT.md section 13 for the setup.
//
//   BEFORE / AFTER   commit range of the push (env, or --before / --after). AFTER defaults to HEAD.
//   --all            announce every page (first run, or after the search engines lost track of the site)
//   --dry-run        print what would be sent, send nothing, wait for nothing
//   --no-wait        do not wait for the deploy to appear on the live site
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'frontend/src/lib/publicPages.js'
const { publicPages, SITE_ORIGIN } = await import(pathToFileURL(path.join(root, REGISTRY)).href)
const { changedPages, submitIndexNow, waitForDeploy, INDEXNOW_KEY } = await import(pathToFileURL(path.join(root, 'frontend/seo/indexnow.js')).href)
const { absoluteUrl } = await import(pathToFileURL(path.join(root, 'frontend/seo/render.js')).href)

const argv = process.argv.slice(2)
const flag = n => argv.includes(n)
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const all = flag('--all') || process.env.ALL === 'true'
const dry = flag('--dry-run')
const before = arg('--before') || process.env.BEFORE || ''
const after = git('rev-parse', arg('--after') || process.env.AFTER || 'HEAD')
const hasBefore = /^[0-9a-f]{7,40}$/i.test(before) && !/^0+$/.test(before)

let previous = []
let changedFiles = []
if (!all && hasBefore) {
  try {
    changedFiles = git('diff', '--name-only', before, after).split('\n').filter(Boolean)
    const tmp = path.join(os.tmpdir(), `publicPages.${process.pid}.mjs`)   // the previous commit's registry (self-contained by design)
    fs.writeFileSync(tmp, git('show', `${before}:${REGISTRY}`))
    try { previous = (await import(pathToFileURL(tmp).href)).publicPages() } finally { fs.rmSync(tmp, { force: true }) }
  } catch (e) {
    console.log(`indexnow: could not read the previous state (${e.message.split('\n')[0]}); announcing every page.`)
    previous = []
    changedFiles = []
  }
}

const urls = changedPages({ before: previous, after: publicPages(), changedFiles, all }).map(p => absoluteUrl(p.path, SITE_ORIGIN))
if (!urls.length) { console.log('indexnow: no public page changed in this push; nothing to announce.'); process.exit(0) }
console.log(`indexnow: ${urls.length} URL(s) to announce:\n  ${urls.join('\n  ')}`)
if (dry) process.exit(0)

if (!flag('--no-wait') && process.env.NO_WAIT !== 'true') {
  const isAncestor = (a, b) => { try { git('merge-base', '--is-ancestor', a, b); return true } catch { return false } }
  console.log(`indexnow: waiting for ${after.slice(0, 7)} to go live at ${SITE_ORIGIN} ...`)
  if (!(await waitForDeploy({ origin: SITE_ORIGIN, sha: after, isAncestor }))) {
    console.error('indexnow: the deploy did not appear on the live site within 25 minutes (did the Cloudflare Pages build fail?). Nothing was announced. Re-run the workflow with "all" once it is live.')
    process.exit(1)
  }
}

await submitIndexNow(urls, { origin: SITE_ORIGIN, key: INDEXNOW_KEY })
console.log('indexnow: accepted.')
