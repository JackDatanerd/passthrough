import { cn } from '../../lib/utils'
import Spinner from './Spinner'
import EmptyState from './EmptyState'

// Shared table shell for the admin/dashboard lists, which each hand-copied the same wrapper,
// header styling, loading and empty states (and, in places, left out the caption and header
// scope a screen reader needs).
//
//   <DataTable
//     caption="Users"                       // visually hidden, names the table for assistive tech
//     columns={[{ key: 'email', header: 'Email' }, { key: 'plan', header: 'Plan', className: 'text-right' }]}
//     rows={users}
//     rowKey={u => u.id}
//     renderCell={(row, col) => ...}       // optional; default is row[col.key]
//     loading={loading}
//     empty="No users found."              // string/node shown via EmptyState
//   />
//
// `columns[i].cell(row)` overrides both the default and renderCell for that column.
export default function DataTable({
  caption, columns, rows, rowKey, renderCell, loading = false, empty, className, rowClassName,
}) {
  if (loading && (!rows || rows.length === 0)) {
    return <div className="flex justify-center py-12"><Spinner /></div>
  }
  if (!loading && (!rows || rows.length === 0)) {
    return empty ? <EmptyState>{empty}</EmptyState> : null
  }
  return (
    <div className={cn('overflow-x-auto rounded-lg border border-gray-200 bg-white', loading && 'opacity-60', className)} aria-busy={loading || undefined}>
      <table className="min-w-full text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
          <tr>
            {columns.map(col => (
              <th key={col.key} scope="col" className={cn('px-4 py-2 font-medium', col.className)}>{col.header}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row, i) : i} className={typeof rowClassName === 'function' ? rowClassName(row) : rowClassName}>
              {columns.map(col => (
                <td key={col.key} className={cn('px-4 py-2 text-gray-700', col.className)}>
                  {col.cell ? col.cell(row) : renderCell ? renderCell(row, col) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
