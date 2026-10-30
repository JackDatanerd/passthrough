'use strict'

// Experts Phase 1: the "no invented facts" check. Every figure in the delivered text must already be in what the CLIENT gave us (their
// own resume, an edit they made themselves, the brief, an answered question, an uploaded material) or be confirmed by the operator.
// Words are the expert's; numbers are the client's.
//
// A5 audit round 1: figures are compared by VALUE ("$1.2 million" = "$1.2M" = 1200000; "30 percent" = "30 %" = "30%"); a spelled-out
// quantity ("five engineers", "tripled") counts as a figure; a lone digit counts too ("a team of 8"). The AI draft and the job posting
// are NOT sources: a figure that only they carry is reported with where it came from, so the operator can ask the customer.
const { leaves } = require('./humanLocks')

const FIG = /(?<![\w.])[$£€]?\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|per\s?cent\b|pct\b|million\b|billion\b|thousand\b|bn\b|mm\b|[kmb]\b|x\b|\+)?/gi
const MARKERISH = /\[\[(?:lock:[\w.]+|c:\d+)\]\]/g
const NUM_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 }
const MULTIPLIERS = { doubled: '2x', twofold: '2x', tripled: '3x', threefold: '3x', quadrupled: '4x', fourfold: '4x', quintupled: '5x', halved: 'half', 'in half': 'half' }
const WORD_NUM = new RegExp(`(?<![\\w-])(${Object.keys(NUM_WORDS).join('|')})(?![\\w-])`, 'gi')
const WORD_MULT = new RegExp(`(?<![\\w-])(${Object.keys(MULTIPLIERS).join('|').replace(' ', '\\s+')})(?![\\w-])`, 'gi')

// "$1.2 million" / "$1.2M" / "1,200,000" -> "1200000"; "30 percent" -> "30%"; a trailing x or + is kept (2x, 10+: a different claim)
function canon(raw) {
  const s = raw.trim().toLowerCase().replace(/[$£€,\s]/g, '')
  const m = /^(\d+(?:\.\d+)?)(%|percent|pct|percent|per?cent|k|m|mm|b|bn|million|billion|thousand|x|\+)?$/.exec(s)
  if (!m) return s
  const suf = m[2] || ''; let num = parseFloat(m[1])
  if (suf === 'k' || suf === 'thousand') num *= 1e3
  else if (suf === 'm' || suf === 'mm' || suf === 'million') num *= 1e6
  else if (suf === 'b' || suf === 'bn' || suf === 'billion') num *= 1e9
  const pct = /^(%|percent|pct|per?cent)$/.test(suf)
  return String(Number(num.toPrecision(12))) + (pct ? '%' : suf === 'x' || suf === '+' ? suf : '')
}

// [{ key, text }] for every figure in a text (markers ignored)
function figureItems(text) {
  const t = String(text || '').replace(MARKERISH, ' '); const out = []
  for (const m of t.matchAll(FIG)) out.push({ key: canon(m[0]), text: m[0].trim() })
  for (const m of t.matchAll(WORD_NUM)) out.push({ key: String(NUM_WORDS[m[1].toLowerCase()]), text: m[0] })
  for (const m of t.matchAll(WORD_MULT)) out.push({ key: MULTIPLIERS[m[1].toLowerCase().replace(/\s+/g, ' ')], text: m[0] })
  return out
}
const figuresIn = text => new Set(figureItems(text).map(f => f.key))
const textsOf = body => Object.values(leaves(body || {})).filter(v => typeof v === 'string')
const keysOf = src => { const s = new Set(); for (const t of (typeof src === 'string' ? [src] : textsOf(src))) for (const f of figuresIn(t)) s.add(f); return s }

// -> [{ text, key, count, origin }]: figures in `finalBody` that appear in none of the allowed (client-given) sources.
// `labelled` = { ai_draft: [sources], job_posting: [sources] } only LABELS where a flagged figure came from; it never allows one.
function newFiguresDetailed(finalBody, allowedSources = [], extraText = [], labelled = {}) {
  const allowed = new Set()
  for (const src of allowedSources) for (const k of keysOf(src)) allowed.add(k)
  for (const t of extraText) for (const k of figuresIn(t)) allowed.add(k)
  const labels = Object.entries(labelled).map(([name, srcs]) => { const s = new Set(); for (const src of srcs || []) for (const k of keysOf(src)) s.add(k); return [name, s] })
  const found = new Map()
  for (const t of textsOf(finalBody)) for (const f of figureItems(t)) {
    if (allowed.has(f.key)) continue
    const cur = found.get(f.key)
    if (cur) cur.count += 1
    else found.set(f.key, { text: f.text, key: f.key, count: 1, origin: (labels.find(([, s]) => s.has(f.key)) || ['nowhere'])[0] })
  }
  return [...found.values()].sort((a, b) => a.text.localeCompare(b.text))
}
const newFigures = (finalBody, allowedSources = [], extraText = []) => newFiguresDetailed(finalBody, allowedSources, extraText).map(f => f.text)

module.exports = { figuresIn, figureItems, newFigures, newFiguresDetailed }
