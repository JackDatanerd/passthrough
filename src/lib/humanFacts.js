'use strict'

// Experts Phase 1: the "no invented facts" check. Every figure in the delivered text must already be in what the client gave us
// (their resume, the brief, an answered question) or be confirmed by the operator. Words are the expert's; numbers are the client's.
const { leaves } = require('./humanLocks')

const FIG = /(?<![\w.])[$£€]?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKmMbB]\b|bn\b|x\b|\+)?/g
const norm = s => s.replace(/[,\s$£€]/g, '').toLowerCase()
const MARKERISH = /\[\[(?:lock:[\w.]+|c:\d+)\]\]/g

function figuresIn(text) {
  const out = new Set()
  for (const m of String(text || '').replace(MARKERISH, ' ').matchAll(FIG)) {
    const f = norm(m[0]); if (/^\d$/.test(f)) continue          // a lone digit ("2 teams") is too noisy to police
    out.add(f)
  }
  return out
}
const textsOf = body => Object.values(leaves(body || {})).filter(v => typeof v === 'string')

// -> figures in `finalBody` (and cover letter text) that appear in none of the allowed sources
function newFigures(finalBody, allowedSources = [], extraText = []) {
  const allowed = new Set()
  for (const src of allowedSources) for (const t of (typeof src === 'string' ? [src] : textsOf(src))) for (const f of figuresIn(t)) allowed.add(f)
  for (const t of extraText) for (const f of figuresIn(t)) allowed.add(f)
  const found = new Map()
  for (const t of textsOf(finalBody)) for (const f of figuresIn(t)) if (!allowed.has(f)) found.set(f, (found.get(f) || 0) + 1)
  return [...found.keys()].sort()
}

module.exports = { figuresIn, newFigures }
