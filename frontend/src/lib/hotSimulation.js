// A random "what if" for the admin Hot categories simulator: pretend interview reports on EVERY field, for both windows,
// shaped to exercise the homepage section rather than to be statistically realistic:
//   * a random number of fields (3 up to all but one) clear the threshold in the 7-day window, the rest stay under it —
//     so you see the ranking, the "Show all N fields" button, fields that are missing, and the sample fallback's opposite;
//   * the 30-day count is never below the 7-day count (the month contains the week);
//   * the period BEFORE each window is random too, a mix of bigger / smaller / too-small-to-quote, so the ▲ ▼ and "—"
//     arrows all appear.
// The simulator ADDS pretend reports on top of the real ones, so every target is turned into "what to add" by subtracting
// what is really there (never below 0). `rng` is injectable so a test can pin the outcome.

const whole = (v) => Math.max(0, Math.floor(Number(v) || 0))

export function randomSimulation({ categories, threshold, real = {}, rng = Math.random }) {
  const floor = Math.max(1, whole(threshold))
  const pick = (n) => Math.floor(rng() * n)             // 0 .. n-1
  const cats = [...categories]
  for (let i = cats.length - 1; i > 0; i--) { const j = pick(i + 1); [cats[i], cats[j]] = [cats[j], cats[i]] }   // shuffle
  const lo = Math.min(3, Math.max(cats.length - 1, 0)), hi = Math.max(cats.length - 1, 0)
  const hotCount = lo + pick(hi - lo + 1)
  const hot = new Set(cats.slice(0, hotCount))

  const adds = { 7: {}, 30: {} }, prevAdds = { 7: {}, 30: {} }
  const targets = {}
  for (const c of categories) {
    const t7 = hot.has(c) ? floor + pick(floor * 3) : pick(floor)               // at/over the line, or safely under it
    const t30 = t7 + pick(floor * (hot.has(c) ? 3 : 2) + 1)                     // the month includes the week
    const swing = (t) => Math.floor(t * (0.4 + rng() * 1.2))                    // 40% .. 160% of this period
    targets[c] = { 7: { cur: t7, prev: swing(t7) }, 30: { cur: t30, prev: swing(t30) } }
  }
  for (const w of [7, 30]) {
    for (const c of categories) {
      const have = (real[w] && real[w][c]) || {}
      adds[w][c] = Math.max(0, targets[c][w].cur - whole(have.current))
      prevAdds[w][c] = Math.max(0, targets[c][w].prev - whole(have.previous))
    }
  }
  return { adds, prevAdds, hotCount }
}
