// Pure paging maths shared by every paginated list, so "how many pages" and
// "which page should we actually be on" are answered in one place.

export function totalPagesFor(total, pageSize) {
  const t = Number(total), s = Number(pageSize)
  if (!Number.isFinite(t) || !Number.isFinite(s) || t <= 0 || s <= 0) return 1
  return Math.max(1, Math.ceil(t / s))
}

// The page to show given the current one and the latest total. A list can
// shrink underneath the person (an item deleted, banned, or filtered out on the
// last page); without this they land on an empty page 3 of 2 — and because
// <Pagination> renders nothing for a single page, with no controls to leave it.
export function clampPage(page, total, pageSize) {
  const p = Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 1
  return Math.min(Math.max(1, p), totalPagesFor(total, pageSize))
}
