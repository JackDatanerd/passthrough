import { ATS_PASS_THRESHOLD } from '../../lib/scoreThresholds'

const CATS = [
  { key: 'keywordScore',  label: 'Keyword Match' },
  { key: 'formatScore',   label: 'Formatting'    },
  { key: 'sectionsScore', label: 'Sections'      },
  { key: 'contentScore',  label: 'Content'       },
]

// AUDIT FIX: hardcoded `75` per category — see scoreThresholds.js for why
// this now references the shared constant instead of its own copy. No
// per-category server-computed pass/fail exists to defer to (the backend
// only computes pass/fail on the overall score), so this stays a threshold
// comparison — just a shared one instead of a third independent copy.
export default function CategoryScores({ scan }) {
  return (
    <div className="flex flex-col gap-3">
      {CATS.map(({ key, label }) => {
        const val = scan?.[key] ?? 0
        const color = val >= ATS_PASS_THRESHOLD ? 'bg-green-500' : val >= 50 ? 'bg-amber-400' : 'bg-red-500'
        const text  = val >= ATS_PASS_THRESHOLD ? 'text-green-700' : val >= 50 ? 'text-amber-700' : 'text-red-700'
        return (
          <div key={key}>
            <div className="flex justify-between items-center mb-1">
              <span className="text-sm text-gray-600">{label}</span>
              <span className={`text-sm font-semibold ${text}`}>{val}</span>
            </div>
            <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${color}`}
                style={{ width: `${val}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
