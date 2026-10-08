import { useCallback, useEffect, useState } from 'react'
import axios from 'axios'
import api, { getErrorMessage } from '../lib/api'
import useLatestRequest from './useLatestRequest'

// GET loader with loading / error / reload, latest-request-wins, and abort on supersede/unmount.
// `url` null/undefined skips the fetch. `params` is compared by value (JSON), so passing a fresh
// object literal each render does not refetch.
//
//   const { data, loading, error, reload } = useFetch('/admin/users', { page, pageSize })
//
// `select` maps the axios response to the stored value (default: res.data.data).
export default function useFetch(url, params, { select = res => res.data.data, fallback } = {}) {
  const begin = useLatestRequest()
  const [state, setState] = useState({ data: null, meta: null, loading: !!url, error: '' })
  const paramsKey = JSON.stringify(params ?? null)

  const run = useCallback(async (controller, { silent = false } = {}) => {
    if (!url) return
    const isCurrent = begin()
    if (!silent) setState(s => ({ ...s, loading: true, error: '' }))
    try {
      const res = await api.get(url, { params: paramsKey === 'null' ? undefined : JSON.parse(paramsKey), signal: controller?.signal })
      if (!isCurrent()) return
      setState({ data: select(res), meta: res.data?.meta ?? null, loading: false, error: '' })
    } catch (err) {
      if (!isCurrent() || axios.isCancel(err)) return
      setState(s => ({ ...s, loading: false, error: getErrorMessage(err, fallback) }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, paramsKey, begin])

  useEffect(() => {
    const controller = new AbortController()
    run(controller)
    return () => controller.abort()
  }, [run])

  const reload = useCallback(() => run(undefined, { silent: true }), [run])
  return { ...state, reload }
}
