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
  compact = false, prevLabel = 'Prev', nextLabel = 'Next', countClassName
}) {
  if (totalPages <= 1) return null
  return (
    <div className={className || 'flex items-center justify-center gap-3'}>
      <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>{prevLabel}</Button>
      <span className={countClassName || (compact ? 'text-xs text-gray-500' : 'text-sm text-gray-500')}>Page {page} of {totalPages}</span>
      <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>{nextLabel}</Button>
    </div>
  )
}
