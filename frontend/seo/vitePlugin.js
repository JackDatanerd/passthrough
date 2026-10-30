// Vite plugin: after the production build, writes the search-indexing files into the output folder.
//
//   sitemap.xml        every page in src/lib/publicPages.js (replaces the hand-kept public/sitemap.xml, which only knew
//                      the pages somebody remembered to add), stamped with the commit being built
//   <path>.html        for each registered page except "/": a copy of the built index.html whose <head> is that page's
//                      own (see render.js). Cloudflare Pages serves a real file before it falls back to index.html, so
//                      /pricing is answered from pricing.html. If a file is somehow not used, the request gets
//                      index.html as before; the only loss is the per-page head. It never makes a page worse.
//
// A malformed registry fails the build (a bad sitemap must not ship, and the previous deploy stays live). A problem
// with one page's head copy is a warning and that page keeps the shared index.html.
import fs from 'node:fs'
import path from 'node:path'
import { publicPages, validatePublicPages } from '../src/lib/publicPages.js'
import { sitemapXml, outputPathFor, renderPageHtml } from './render.js'

export default function seoPlugin() {
  let outDir = ''
  return {
    name: 'passthrough-search-indexing',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const shellFile = path.join(outDir, 'index.html')
      if (!outDir || !fs.existsSync(shellFile)) return   // the build itself failed or emitted nothing: nothing to add to
      const pages = publicPages()
      const problems = validatePublicPages(pages)
      if (problems.length) throw new Error(`publicPages.js is invalid:\n  - ${problems.join('\n  - ')}`)

      // Cloudflare Pages sets CF_PAGES_COMMIT_SHA for every build; GitHub Actions sets GITHUB_SHA.
      const buildId = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || 'dev'
      fs.writeFileSync(path.join(outDir, 'sitemap.xml'), sitemapXml(pages, { buildId }))

      const shell = fs.readFileSync(shellFile, 'utf8')
      for (const page of pages) {
        const rel = outputPathFor(page.path)
        if (!rel) continue
        const target = path.join(outDir, rel)
        try {
          if (fs.existsSync(target)) throw new Error(`${rel} already exists in the build output`)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, renderPageHtml(shell, page))
        } catch (e) {
          this.warn(`[search-indexing] ${page.path}: no page-specific head written (${e.message}); it will use index.html`)
        }
      }
    },
  }
}
