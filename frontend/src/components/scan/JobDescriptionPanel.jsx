// G5 (Scan/ATS round 3): the job description a scan is scored against used to be invisible once
// submitted - most of all for a posting fetched from a URL, where a cookie wall, a login page or the
// wrong listing silently produced a score for a job nobody applied to. This shows the exact text that
// was scored (after any trimming of an over-long posting), so a wrong read is obvious at a glance.
// Collapsed by default; renders nothing when there is no stored text.
export default function JobDescriptionPanel({ scan }) {
  const text = scan?.jobDescriptionText
  if (!text || !String(text).trim()) return null
  const url = scan.jobDescriptionUrl
  const safeUrl = typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
  return (
    <details className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-3" data-testid="jd-panel">
      <summary className="cursor-pointer text-sm font-medium text-gray-800">
        The job description we scored against
        {scan.jobTitle ? <span className="text-gray-500 font-normal"> — {scan.jobTitle}</span> : null}
      </summary>
      <p className="mt-2 text-xs text-gray-500">
        {safeUrl
          ? <>Read from <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all">{safeUrl}</a>. </>
          : null}
        If this isn't the posting you meant, scan again against the right one — a wrong job description gives a
        meaningless score.
      </p>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 border border-gray-100 p-3 text-xs text-gray-700 font-sans">{text}</pre>
    </details>
  )
}
