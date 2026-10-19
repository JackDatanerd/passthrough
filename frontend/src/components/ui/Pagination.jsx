import Button from './Button'

// FEATURE GAP CLOSED (audit): this exact block — Prev/page-count/Next, same
// Tailwind classes, same disabled logic — was copy-pasted verbatim across
// AdminPayments, AdminScans, AdminUsers, AdminSystemHealth (twice — it has
// two independently paginated lists), and dashboard/Index. One shared
// component instead of seven near-identical copies.
//
//   const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
//   {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
export default function Pagination({
  page, totalPages, onChange, className,
  compact = false, prevLabel = 'Prev', nextLabel = 'Next', countClassName, ariaLabel = 'Pagination'
}) {
  if (!Number.isFinite(Number(totalPages)) || totalPages <= 1) return null
  const atStart = page <= 1
  const atEnd = page >= totalPages
  // SHARED FRONTEND (section 11, round 19, bug): Prev / Next used the native `disabled` attribute. Pressing Next on the
  // second-to-last page (or Prev on page 2) disabled the very button that held focus, so a keyboard or screen-reader user was
  // left on a dead control (or dropped on <body>) and could not carry on — the same defect <Button loading> was fixed for. At
  // either end the button now stays focusable and is marked aria-disabled; its click is swallowed here.
  return (
    <nav aria-label={ariaLabel} className={className || 'flex items-center justify-center gap-3'}>
      <Button size="sm" variant="secondary" aria-disabled={atStart || undefined} onClick={() => { if (!atStart) onChange(Math.max(1, Math.min(page - 1, totalPages))) }}>{prevLabel}</Button>
      <span aria-live="polite" className={countClassName || (compact ? 'text-xs text-gray-500' : 'text-sm text-gray-500')}>Page {page} of {totalPages}</span>
      <Button size="sm" variant="secondary" aria-disabled={atEnd || undefined} onClick={() => { if (!atEnd) onChange(page + 1) }}>{nextLabel}</Button>
    </nav>
  )
}
