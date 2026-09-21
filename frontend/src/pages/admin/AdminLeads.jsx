import { useState, useEffect } from 'react'
import api from '../../lib/api'
import Spinner from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'

// Calls the existing GET /api/employer-leads (admin-gated) endpoint rather
// than a duplicate /api/admin/leads — that retrieval gap was already closed
// directly in employer-leads.controller.js. Unpaginated to match that
// endpoint's own shape (low volume today; add pagination to both together
// if that ever changes).
export default function AdminLeads() {
  const toast = useToast()
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/employer-leads')
      .then(res => setLeads(res.data.data))
      .catch(() => toast({ message: 'Failed to load leads.', type: 'error' }))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-gray-900">Employer Leads</h1>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : leads.length === 0 ? (
        <p className="text-sm text-gray-500">No leads yet.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role category</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {leads.map(l => (
                <tr key={l.id}>
                  <td className="px-4 py-3 font-medium text-gray-900">{l.name}</td>
                  <td className="px-4 py-3 text-gray-600">{l.company}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <a href={`mailto:${l.email}`} className="text-blue-600 hover:underline">{l.email}</a>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{l.roleCategory || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{l.source}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
