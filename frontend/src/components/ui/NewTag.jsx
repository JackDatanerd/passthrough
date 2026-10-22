// A small "NEW" marker for a freshly shipped feature, drawn beside a feature line.
export default function NewTag({ className = '' }) {
  return (
    <span data-testid="new-tag" className={`inline-block align-middle rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-emerald-800 ${className}`}>
      New
    </span>
  )
}
