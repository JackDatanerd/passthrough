import { Fragment } from 'react'
import { cn } from '../../lib/utils'
import Spinner from './Spinner'
import EmptyState from './EmptyState'

// Shared table shell for the admin/dashboard lists. Ten pages each hand-copied the same wrapper, header styling, caption and
// `scope="col"` headers (this component existed for a long time with no caller, because its defaults did not match what those
// pages actually look like — it now does, so adopting it changes nothing visible).
//
//   <DataTable
//     caption="Users"                       // visually hidden, names the table for assistive tech
//     columns={[
//       { key: 'email', header: 'Email', cell: u => u.email, cellClassName: 'text-gray-600' },
//       { key: 'amount', header: 'Amount', className: 'text-right', cell: u => formatCents(u.cents) },
//       { key: 'actions', header: <span className="sr-only">Actions</span>, cell: u => <Button …/> },
//     ]}
//     rows={users}
//     rowKey={u => u.id}
//     rowClassName={u => (u.voided ? 'bg-gray-50 text-gray-400' : '')}
//     expandedRow={u => (open === u.id ? <pre>…</pre> : null)}   // a full-width detail row under that row
//     density="compact"                     // px-3 py-2 instead of px-4 py-3
//     loading={loading}                     // only with no rows yet: spinner; with rows: dimmed + aria-busy
//     empty="No users found."               // string/node shown via EmptyState
//   />
//
// Column fields: `className` goes on the header AND the cells (alignment), `headerClassName` / `cellClassName` on one of them,
// `cellClassName` may be a function of the row (`row => …`). `cell(row, index)` renders the cell (else `renderCell(row, col)`, else `row[col.key]`). `header` may be a node.
// Cells carry no default text colour — set it per column (`cellClassName`) as the pages always did.
export default function DataTable({
  caption, columns, rows, rowKey, renderCell, loading = false, empty, className, rowClassName,
  expandedRow, expandedClassName, density = 'comfortable',
}) {
  if (loading && (!rows || rows.length === 0)) {
    return <div className="flex justify-center py-16"><Spinner /></div>
  }
  if (!loading && (!rows || rows.length === 0)) {
    return empty ? <EmptyState>{empty}</EmptyState> : null
  }
  const pad = density === 'compact' ? 'px-3 py-2' : 'px-4 py-3'
  return (
    <div className={cn('overflow-x-auto rounded-lg border border-gray-200 bg-white', loading && 'opacity-60', className)} aria-busy={loading || undefined}>
      <table className="w-full text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
            {columns.map(col => (
              <th key={col.key} scope="col" className={cn(pad, col.className, col.headerClassName)}>{col.header}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row, i) => {
            const key = rowKey ? rowKey(row, i) : i
            const extra = expandedRow ? expandedRow(row, i) : null
            return (
              <Fragment key={key}>
                <tr className={typeof rowClassName === 'function' ? rowClassName(row, i) : rowClassName}>
                  {columns.map(col => (
                    <td key={col.key} className={cn(pad, col.className, typeof col.cellClassName === 'function' ? col.cellClassName(row, i) : col.cellClassName)}>
                      {col.cell ? col.cell(row, i) : renderCell ? renderCell(row, col) : row[col.key]}
                    </td>
                  ))}
                </tr>
                {extra ? (
                  <tr>
                    <td colSpan={columns.length} className={cn('px-4 pb-4 bg-gray-50', expandedClassName)}>{extra}</td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
