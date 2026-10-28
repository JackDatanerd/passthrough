'use strict'

// Experts Phase 1: what changed between two structured documents (path by path, then word by word), computed on the SERVER.
const { leaves } = require('./humanLocks')

const tok = s => String(s ?? '').split(/(\s+)/).filter(x => x !== '')
const MAX_TOKENS = 400

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

// Path-level changes between two bodies. Unchanged paths are omitted.
function diffDocuments(before, after) {
  const a = leaves(before || {}), b = leaves(after || {}), out = []
  for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[p], y = b[p]
    if (x === y) continue
    const kind = x == null || x === '' ? 'added' : y == null || y === '' ? 'removed' : 'changed'
    out.push({ path: p, kind, before: x ?? null, after: y ?? null, ops: wordDiff(x, y) })
  }
  return out
}

module.exports = { wordDiff, diffDocuments }
