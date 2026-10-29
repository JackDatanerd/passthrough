// The Desk: empty until the claim queue and workbench ship (Phase 2B and later). It lists only jobs assigned to this expert.
import { useEffect, useState } from 'react'
import { realm, errorMessage } from '../api'
import { Page } from '../Layout'
import EmptyState from '../../components/ui/EmptyState'
import Spinner from '../../components/ui/Spinner'
import Alert from '../../components/ui/Alert'
import DataTable from '../../components/ui/DataTable'

export default function Desk() {
  const [jobs, setJobs] = useState(null); const [error, setError] = useState('')
  useEffect(() => { realm.desk().then(setJobs).catch(err => setError(errorMessage(err))) }, [])
  return (
    <Page title="Your desk" wide>
      {error && <Alert variant="error">{error}</Alert>}
      {!jobs && !error && <Spinner />}
      {jobs && jobs.length === 0 && <EmptyState>Nothing on your desk. Jobs an admin assigns to you will appear here.</EmptyState>}
      {jobs && jobs.length > 0 && (
        <div className="sheet"><DataTable caption="Jobs on your desk" rows={jobs} rowKey={j => j.id} density="compact" columns={[
          { key: 'job', header: 'Job', cell: j => <span className="serif">{j.jobNumber}</span> }, { key: 'state', header: 'State', cell: j => j.state.replace(/_/g, ' ') },
          { key: 'tier', header: 'Service', cell: j => j.tierLabel }, { key: 'due', header: 'Due', cell: j => (j.dueAt ? new Date(j.dueAt).toUTCString() : '') }]} /></div>
      )}
    </Page>
  )
}
