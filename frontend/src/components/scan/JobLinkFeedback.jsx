import Alert from '../ui/Alert'

// What can be said about a job link while it is typed (lib/scanJobLink.js decides): LinkedIn cannot be read (with the way out),
// junk is flagged, a good one is welcomed. Shared by the /scan page and the homepage card.
export default function JobLinkFeedback({ jobLink, onSwitchToPaste }) {
  return (
    <>
      {jobLink === 'blocked' && (
        <Alert variant="warning" data-testid="link-blocked" className="mt-2" action={{ label: 'Switch to paste', onClick: onSwitchToPaste }}>
          <b>LinkedIn can’t be read automatically.</b> Copy the posting text instead.
        </Alert>
      )}
      {jobLink === 'bad' && <Alert variant="error" data-testid="link-bad" className="mt-2">That doesn’t look like a web address.</Alert>}
      {jobLink === 'ok' && <Alert variant="success" data-testid="link-ok" className="mt-2">Looks good. We’ll read the page when you scan. If it can’t be read, you come straight back here with everything you entered.</Alert>}
    </>
  )
}
