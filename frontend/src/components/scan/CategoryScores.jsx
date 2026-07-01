const CATS = [
  { key: 'keywordScore',  label: 'Keyword Match' },
  { key: 'formatScore',   label: 'Formatting'    },
  { key: 'sectionsScore', label: 'Sections'      },
  { key: 'contentScore',  label: 'Content'       },
]

export default function CategoryScores({ scan }) {
  return (
    <div className="flex flex-col gap-3">
      {CATS.map(({ key, label }) => {
        const val = scan?.[key] ?? 0
        const color = val >= 75 ? 'bg-green-500' : val >= 50 ? 'bg-amber-400' : 'bg-red-500'
        const text  = val >= 75 ? 'text-green-700' : val >= 50 ? 'text-amber-700' : 'text-red-700'
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
