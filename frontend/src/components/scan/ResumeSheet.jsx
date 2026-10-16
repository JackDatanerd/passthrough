// Abstract resume page used by the scan and fix waiting states.
//
// It deliberately shows NO real text and NO per-line verdicts: while a scan or fix
// is running the page does not know the resume's lines, so anything line-specific
// (an amber "problem" mark, a rewritten sentence) would be invented. The page is a
// quiet stand-in for the document; a beam sweeps it while work is in flight.
const ROWS = [
  { k: 'name', w: 46 }, { k: 'sub', w: 30 },
  { k: 'head', w: 24 }, { w: 90 }, { w: 78 }, { w: 84 },
  { k: 'head', w: 24 }, { w: 92 }, { w: 70 }, { w: 86 }, { w: 64 },
  { k: 'head', w: 24 }, { w: 88 }, { w: 74 },
]
const SWEEP_SECONDS = 14   // one pass of the beam; it then loops while work continues

export default function ResumeSheet({ elapsedSeconds = 0, tone = 'blue' }) {
  const sweep = (elapsedSeconds % SWEEP_SECONDS) / SWEEP_SECONDS
  // Rows are "read" for good once the first pass has gone over them; after that the
  // beam keeps looping over a fully-read page, which says "still working", not "x%".
  const firstPass = elapsedSeconds < SWEEP_SECONDS
  const beamColor = tone === 'green' ? 'bg-green-600' : 'bg-blue-600'
  return (
    <div
      aria-hidden="true"
      data-testid="resume-sheet"
      className="relative shrink-0 w-24 sm:w-36 aspect-[8.5/11] rounded border border-gray-200 bg-white shadow-sm overflow-hidden px-3 py-3"
    >
      {ROWS.map((r, i) => {
        const read = !firstPass || sweep >= (i + 1) / ROWS.length
        const h = r.k === 'name' ? 'h-2' : r.k === 'head' ? 'h-1.5 mt-2.5' : 'h-1'
        return (
          <div
            key={i}
            style={{ width: `${r.w}%` }}
            className={`${h} mb-1.5 rounded-sm motion-safe:transition-colors motion-safe:duration-500 ${read ? 'bg-gray-500' : 'bg-gray-200'}`}
          />
        )
      })}
      <div
        data-testid="resume-beam"
        style={{ top: `${sweep * 100}%` }}
        className={`motion-reduce:hidden absolute left-0 right-0 h-0.5 ${beamColor} opacity-80 motion-safe:transition-[top] motion-safe:duration-500 motion-safe:ease-linear`}
      />
    </div>
  )
}
