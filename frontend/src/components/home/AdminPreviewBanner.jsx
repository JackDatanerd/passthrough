import { Link } from 'react-router-dom'

// Shown on the homepage, to the signed-in admin only, while a Hot categories simulation is being previewed there. It is the
// one thing that stops simulated interview counts from being mistaken for real ones, so it is not dismissable except by
// ending the preview.
export default function AdminPreviewBanner({ threshold, onClear }) {
  return (
    <div role="status" data-testid="admin-preview-banner" className="bg-amber-100 border-b-2 border-amber-400 text-amber-950">
      <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        <b>Admin preview</b>
        <span>
          The “Hot categories” section below shows <b>simulated</b> numbers{threshold ? <> (threshold {threshold})</> : null}. Only you see this, in this browser; visitors see the real data.
        </span>
        <span className="sm:ml-auto flex items-center gap-4">
          <Link to="/admin/hot-categories" className="font-semibold underline underline-offset-2">Back to the simulator</Link>
          <button type="button" onClick={onClear} className="font-semibold underline underline-offset-2">End preview</button>
        </span>
      </div>
    </div>
  )
}
