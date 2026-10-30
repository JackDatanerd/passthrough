'use strict'

// Experts Phase 1: what changed between two structured documents (path by path, then word by word), computed on the SERVER.
//
// A5 audit round 1: a list of text items (bullets, skills) is ALIGNED, not compared by position, so inserting or removing one bullet no
// longer makes every bullet after it look changed; a removed item reports its own old position in `beforePath`; null and '' are one thing.
const { leaves } = require('./humanLocks')

const tok = s => String(s ?? '').split(/(\s+)/).filter(x => x !== '')
const MAX_TOKENS = 400
const MAX_ALIGN = 250000

// Longest-common-subsequence word diff -> [{ t: 'eq'|'ins'|'del', text }] (adjacent same-type ops merged)
function wordDiff(a, b) {
  const A = tok(a), B = tok(b)
  if (A.length > MAX_TOKENS || B.length > MAX_TOKENS) return [{ t: 'del', text: String(a ?? '') }, { t: 'ins', text: String(b ?? '') }].filter(o => o.text)
  const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0))
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const ops = []; let i = 0, j = 0
  const push = (t, text) => { const l = ops[ops.length - 1]; if (l && l.t === t) l.text += text; else ops.push({ t, text }) }
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { push('eq', A[i]); i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) { push('del', A[i]); i++ } else { push('ins', B[j]); j++ }
  }
  while (i < A.length) push('del', A[i++]); while (j < B.length) push('ins', B[j++])
  return ops
}

const isArr = Array.isArray
const isObj = v => v && typeof v === 'object' && !isArr(v)
const prim = v => v == null || typeof v !== 'object'
const empty = v => v == null || v === ''
const join = (p, k) => (p ? `${p}.${k}` : String(k))

function leaf(path, x, y, out, beforePath) {
  if (x === y || (empty(x) && empty(y))) return
  const kind = empty(x) ? 'added' : empty(y) ? 'removed' : 'changed'
  const e = { path, kind, before: x ?? null, after: y ?? null, ops: wordDiff(x, y) }
  if (beforePath && beforePath !== path) e.beforePath = beforePath
  out.push(e)
}

const words = s => new Set(String(s ?? '').toLowerCase().split(/\W+/).filter(Boolean))
function similar(a, b) {
  const A = words(a), B = words(b); if (!A.size || !B.size) return 0
  let both = 0; for (const w of A) if (B.has(w)) both++
  return both / (A.size + B.size - both)
}

// align two lists of primitives: keep what is the same, then pair a removed item with the added item that most resembles it
function alignPrims(a, b, path, out) {
  const n = a.length, m = b.length
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  let i = 0, j = 0; let dels = [], inss = []
  const flush = () => {
    const usedIns = new Set()
    for (const d of dels) {
      let best = -1, bestScore = 0
      inss.forEach((k, idx) => { if (usedIns.has(idx)) return; const sc = similar(a[d], b[k]); if (sc > bestScore) { best = idx; bestScore = sc } })
      if (best < 0 && dels.length === 1 && inss.length === 1) best = 0                  // one out, one in: an edit
      if (best >= 0 && (bestScore >= 0.2 || (dels.length === 1 && inss.length === 1))) { usedIns.add(best); leaf(join(path, inss[best]), a[d], b[inss[best]], out, join(path, d)) }
      else leaf(join(path, d), a[d], undefined, out)
    }
    inss.forEach((k, idx) => { if (!usedIns.has(idx)) leaf(join(path, k), undefined, b[k], out) })
    dels = []; inss = []
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) { flush(); i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) dels.push(i++); else inss.push(j++)
  }
  while (i < n) dels.push(i++); while (j < m) inss.push(j++)
  flush()
}

function walk(a, b, path, out) {
  if (isObj(a) && isObj(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], join(path, k), out); return }
  if (isArr(a) && isArr(b)) {
    if (a.every(prim) && b.every(prim) && a.length * b.length <= MAX_ALIGN) return alignPrims(a, b, path, out)
    for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], join(path, i), out)
    return
  }
  if (prim(a) && prim(b)) return leaf(path, a, b, out)
  if (a == null && !prim(b)) return walk(isArr(b) ? [] : {}, b, path, out)
  if (b == null && !prim(a)) return walk(a, isArr(a) ? [] : {}, path, out)
  const la = leaves(a, path), lb = leaves(b, path)                               // the shape changed (text became a list...): compare leaf by leaf
  for (const p of new Set([...Object.keys(la), ...Object.keys(lb)])) leaf(p, la[p], lb[p], out)
}

// Path-level changes between two bodies. Unchanged paths are omitted.
function diffDocuments(before, after) {
  const out = []; walk(before || {}, after || {}, '', out); return out
}

module.exports = { wordDiff, diffDocuments }
