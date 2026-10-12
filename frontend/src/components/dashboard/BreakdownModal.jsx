import Modal from '../ui/Modal'
import ButtonLink from '../ui/ButtonLink'
import ScoreRing, { barColor } from './ScoreRing'
import { scanHeading, scanDetails } from '../../lib/scanDisplay'
import { formatDate } from '../../lib/utils'
import { displayScore, scanMessage } from '../../lib/scanNext'

const CATEGORIES = [['Keywords', 'keywordScore'], ['Formatting', 'formatScore'], ['Sections', 'sectionsScore'], ['Content', 'contentScore']]

// A quick look at why a scan scored what it did, from the four category scores the list already carries.
// The full report (missing keywords, the rewrite) stays on the scan page.
export default function BreakdownModal({ scan, now, onClose }) {
  if (!scan) return null
  const msg = scanMessage(scan, now)
  const cats = CATEGORIES.filter(([, key]) => scan[key] != null)
  return (
    <Modal open onClose={onClose} title={scanHeading(scan)}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <ScoreRing score={displayScore(scan)} size="lg" />
          <p className="text-sm text-gray-600">{[...scanDetails(scan), formatDate(scan.createdAt)].join(' · ')}</p>
        </div>
        <p className="text-sm text-gray-700"><b className="font-semibold">{msg.label}.</b> {msg.text}</p>
        {cats.length > 0 ? (
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">What the software sees</h3>
            <div className="flex flex-col gap-2">
              {cats.map(([label, key]) => (
                <div key={key} className="grid grid-cols-[6rem_1fr_2rem] items-center gap-2 text-sm">
                  <span className="text-gray-700">{label}</span>
                  <div className="h-2 rounded-full bg-gray-100"><div className={`h-2 rounded-full ${barColor(scan[key])}`} style={{ width: `${scan[key]}%` }} /></div>
                  <b className="text-right tabular-nums">{scan[key]}</b>
                </div>
              ))}
            </div>
          </div>
        ) : <p className="text-sm text-gray-500">The category scores appear once the scan has finished.</p>}
        <div className="flex gap-2 justify-end">
          <ButtonLink to={`/scan/${scan.id}`}>Open the full report</ButtonLink>
        </div>
      </div>
    </Modal>
  )
}
