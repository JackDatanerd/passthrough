import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../../lib/api'
import { useApi } from '../../hooks/useApi'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Modal from '../../components/ui/Modal'
import Form from '../../components/ui/Form'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/Toast'
import { formatCents } from '../../lib/utils'

function AddPartnerModal({ onClose, onCreated }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const { loading: saving, error, execute } = useApi()

  async function handleCreate() {
    if (!name || !email) {
      await execute(() => Promise.reject(new Error('Name and email are required.')),
        { fallback: 'Name and email are required.' }).catch(() => {})
      return
    }
    try {
      await execute(() => api.post('/partners', { name, email }), { fallback: 'Failed to add partner.' })
      toast({ message: `${name} added — payout-details link sent.`, type: 'success' })
      onCreated()
      onClose()
    } catch (_) { /* error already captured by useApi */ }
  }

  return (
    <Modal open onClose={onClose} title="Add partner">
      <Form onSubmit={handleCreate} className="flex flex-col gap-4">
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} />
        <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>Add & send link</Button>
        </div>
      </Form>
    </Modal>
  )
}

export default function AdminPartners() {
  const toast = useToast()
  const [partners, setPartners] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await api.get('/partners')
      setPartners(res.data.data)
    } catch (_) {
      toast({ message: 'Failed to load partners.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const totalReadyToPay = partners.reduce((sum, p) => sum + (p.readyToPayCents || 0), 0)
  const totalAccruing   = partners.reduce((sum, p) => sum + (p.currentCycleAccruedCents || 0), 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Partners</h1>
        <Button onClick={() => setShowAdd(true)}>Add partner</Button>
      </div>

      {!loading && partners.length > 0 && (
        <div className="grid sm:grid-cols-3 gap-4">
          <div className="border border-gray-200 rounded-lg p-4 bg-white">
            <div className="text-xs uppercase tracking-wide text-gray-400">Ready to pay now</div>
            <div className="text-2xl font-bold text-amber-600">{formatCents(totalReadyToPay)}</div>
            <div className="text-xs text-gray-400 mt-1">Completed cycles, unpaid</div>
          </div>
          <div className="border border-gray-200 rounded-lg p-4 bg-white">
            <div className="text-xs uppercase tracking-wide text-gray-400">Still accruing</div>
            <div className="text-2xl font-bold text-gray-900">{formatCents(totalAccruing)}</div>
            <div className="text-xs text-gray-400 mt-1">Current cycle, not yet payable</div>
          </div>
          <div className="border border-gray-200 rounded-lg p-4 bg-white">
            <div className="text-xs uppercase tracking-wide text-gray-400">Active partners</div>
            <div className="text-2xl font-bold text-gray-900">{partners.filter(p => p.status === 'ACTIVE').length}</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : partners.length === 0 ? (
        <p className="text-sm text-gray-500">No partners yet.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="px-4 py-3">Partner</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Rate</th>
                <th className="px-4 py-3 text-right">Ready to pay</th>
                <th className="px-4 py-3 text-right">Accruing ({partners[0]?.currentCycleLabel})</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {partners.map(p => (
                <tr key={p.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{p.name}</div>
                    <div className="text-gray-400 text-xs">{p.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={p.status === 'ACTIVE' ? 'green' : 'gray'}>{p.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{(p.commissionRate * 100).toFixed(0)}%</td>
                  <td className="px-4 py-3 text-right">
                    <span className={p.readyToPayCents > 0 ? 'font-semibold text-amber-600' : 'text-gray-400'}>
                      {formatCents(p.readyToPayCents || 0)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500">
                    {formatCents(p.currentCycleAccruedCents || 0)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/admin/partners/${p.id}`} className="text-blue-600 hover:underline text-xs font-medium">
                      Manage →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <AddPartnerModal onClose={() => setShowAdd(false)} onCreated={load} />}
    </div>
  )
}
