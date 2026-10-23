import { useState, useEffect, useCallback } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Alert from '../../components/ui/Alert'
import Badge from '../../components/ui/Badge'
import Button from '../../components/ui/Button'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import Input from '../../components/ui/Input'
import Spinner from '../../components/ui/Spinner'
import Switch from '../../components/ui/Switch'
import { useToast } from '../../components/ui/Toast'
import { formatCents, formatDate } from '../../lib/utils'
import useLatestRequest from '../../hooks/useLatestRequest'

const TIERS = [
  { key: 'FIX',       label: 'Full fix' },
  { key: 'FIX_PLAIN', label: 'Fix only' },
  { key: 'BADGE',     label: 'Verified badge' },
]

// <input type="datetime-local"> works in the admin's local time; the Worker stores UTC ISO.
const toLocalInput = iso => {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 19)   // seconds kept: a deploy end of 23:59:59 must not round-trip to 23:59:00
}
const fromLocalInput = v => (v ? new Date(v).toISOString() : null)
const centsToField = c => (Number.isInteger(c) ? String(c / 100) : '')
// "29", "29.50", "29,50" and "$29" all read as 2900 / 2950; anything else is NaN (caught before the request is sent).
const fieldToCents = v => {
  const t = String(v ?? '').trim().replace(/^\$/, '').replace(',', '.')
  const n = Number(t)
  return t !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN
}

// Promotions without a deploy: what the Worker charges while a promo runs is set here, not in wrangler.toml / constants.js.
// Saving takes effect within ~30 seconds everywhere. "Revert to deploy settings" removes the saved promo so pricing falls
// back to the wrangler.toml variables.
export default function AdminPromo() {
  const toast = useToast()
  const beginLoad = useLatestRequest()
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState({})
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [form, setForm] = useState({ active: false, label: '', startsAt: '', endsAt: '', prices: { FIX: '', FIX_PLAIN: '', BADGE: '' } })

  const hydrate = useCallback(d => {
    const src = d.saved || null
    const promo = d.effective
    setForm({
      active: src ? !!src.active : !!promo.active,
      label: src ? (src.label || '') : '',
      startsAt: toLocalInput(src ? src.startsAt : promo.startsAt),
      endsAt: toLocalInput(src ? src.endsAt : promo.endsAt),
      prices: {
        FIX: centsToField((src?.prices || promo.promoCents || {}).FIX),
        FIX_PLAIN: centsToField((src?.prices || promo.promoCents || {}).FIX_PLAIN),
        BADGE: centsToField((src?.prices || promo.promoCents || {}).BADGE),
      },
    })
  }, [])

  const load = useCallback(async () => {
    const isCurrent = beginLoad()
    setLoadError(null)
    try {
      const res = await api.get('/admin/promo', { signal: isCurrent.signal })
      if (!isCurrent()) return
      setData(res.data.data)
      hydrate(res.data.data)
    } catch (err) {
      if (!isCurrent()) return
      setLoadError(getErrorMessage(err, 'Could not load the promotion settings.'))
    }
  }, [hydrate])
  useEffect(() => { load() }, [load])

  const currency = data?.effective?.currency || 'USD'
  const money = c => formatCents(c, currency)
  const setPrice = (k, v) => setForm(f => ({ ...f, prices: { ...f.prices, [k]: v } }))

  const save = async () => {
    const bad = TIERS.filter(t => Number.isNaN(fieldToCents(form.prices[t.key])))
    if (bad.length) {
      setErrors(Object.fromEntries(bad.map(t => [`prices.${t.key}`, 'Enter an amount like 29 or 29.50.'])))
      return
    }
    if (!form.endsAt) { setErrors({ endsAt: 'Pick when the promotion ends.' }); return }
    setSaving(true); setErrors({})
    try {
      const res = await api.put('/admin/promo', {
        active: form.active,
        label: form.label.trim(),
        startsAt: fromLocalInput(form.startsAt),
        endsAt: fromLocalInput(form.endsAt) || '',
        prices: { FIX: fieldToCents(form.prices.FIX), FIX_PLAIN: fieldToCents(form.prices.FIX_PLAIN), BADGE: fieldToCents(form.prices.BADGE) },
      })
      const next = { ...data, saved: res.data.data.saved, effective: res.data.data.effective }
      setData(next); hydrate(next)
      toast({ message: 'Promotion saved. It reaches customers within about 30 seconds.', type: 'success' })
    } catch (err) {
      const list = err?.response?.data?.errors
      if (Array.isArray(list)) setErrors(Object.fromEntries(list.map(e => [e.field, e.message])))
      toast({ message: getErrorMessage(err, 'Could not save the promotion.'), type: 'error' })
    } finally { setSaving(false) }
  }

  const revert = async () => {
    setConfirmRevert(false); setSaving(true)
    try {
      const res = await api.delete('/admin/promo')
      const next = { ...data, saved: null, effective: res.data.data.effective }
      setData(next); hydrate(next); setErrors({})
      toast({ message: 'Back on the deploy settings.', type: 'success' })
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Could not revert the promotion.'), type: 'error' })
    } finally { setSaving(false) }
  }

  if (loadError) return <Alert variant="error">{loadError} <button className="underline" onClick={load}>Retry</button></Alert>
  if (!data) return <div className="py-12 flex justify-center"><Spinner /></div>

  const eff = data.effective
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Promotions</h1>
        <p className="text-sm text-gray-500 mt-1">Run a sale without a deploy. Prices are in {currency}; each promo price must be below the standard price.</p>
      </div>

      <section className="border border-gray-200 rounded-lg p-5 bg-white" aria-label="In force now">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="font-semibold text-gray-900">In force now</h2>
          <Badge variant={eff.active ? 'green' : 'gray'}>{eff.active ? `${eff.label} running` : 'Standard pricing'}</Badge>
          <Badge variant="gray">{eff.source === 'admin' ? 'set here' : 'deploy settings'}</Badge>
        </div>
        {eff.endsAt && <p className="text-xs text-gray-500 mb-3">{eff.active ? 'Ends' : 'Ended'} {formatDate(eff.endsAt)}{eff.startsAt ? ` · starts ${formatDate(eff.startsAt)}` : ''}</p>}
        {eff.standardCents && (
          <ul className="text-sm space-y-1">
            {TIERS.map(t => (
              <li key={t.key} className="flex justify-between">
                <span>{t.label}</span>
                <span>{eff.active && eff.promoCents ? <><s className="text-gray-400 mr-2">{money(eff.standardCents[t.key])}</s><b className="text-green-700">{money(eff.promoCents[t.key])}</b></> : money(eff.standardCents[t.key])}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-gray-400 mt-3">Deploy settings (wrangler.toml): {data.deploy?.active ? 'promo on' : 'promo off'}{data.deploy?.endsAt ? `, ends ${formatDate(data.deploy.endsAt)}` : ''}.</p>
      </section>

      <section className="border border-gray-200 rounded-lg p-5 bg-white space-y-4" aria-label="Edit promotion">
        <h2 className="font-semibold text-gray-900">Edit promotion</h2>
        <div className="flex items-center gap-3">
          <Switch label="Promotion on" checked={form.active} onChange={v => setForm(f => ({ ...f, active: v }))} disabled={saving} />
          <span className="text-sm text-gray-700">{form.active ? 'On (within its start and end)' : 'Off'}</span>
        </div>
        <Input label="Name shown to customers" value={form.label} maxLength={data.limits?.labelMax || 40} error={errors.label}
          hint="E.g. Introductory price, Black Friday. Blank uses “Introductory price”."
          onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
        <div className="grid sm:grid-cols-2 gap-4">
          <Input label="Starts (optional)" type="datetime-local" step="1" value={form.startsAt} error={errors.startsAt} onChange={e => setForm(f => ({ ...f, startsAt: e.target.value }))} />
          <Input label="Ends" type="datetime-local" step="1" value={form.endsAt} error={errors.endsAt} onChange={e => setForm(f => ({ ...f, endsAt: e.target.value }))} />
        </div>
        <div className="grid sm:grid-cols-3 gap-4">
          {TIERS.map(t => (
            <Input key={t.key} label={`${t.label} price`} inputMode="decimal" value={form.prices[t.key]} error={errors[`prices.${t.key}`]}
              hint={eff.standardCents ? `Standard ${money(eff.standardCents[t.key])}` : undefined}
              onChange={e => setPrice(t.key, e.target.value)} />
          ))}
        </div>
        <div className="flex gap-3">
          <Button onClick={save} loading={saving}>Save promotion</Button>
          {data.saved && <Button variant="secondary" onClick={() => setConfirmRevert(true)} disabled={saving}>Revert to deploy settings</Button>}
        </div>
        {data.saved?.updatedAt && <p className="text-xs text-gray-400">Last saved {formatDate(data.saved.updatedAt)}.</p>}
      </section>

      <ConfirmDialog open={confirmRevert} title="Revert to deploy settings?" message="The saved promotion is removed and pricing follows wrangler.toml again."
        confirmLabel="Revert" danger={false} onConfirm={revert} onCancel={() => setConfirmRevert(false)} />
    </div>
  )
}
