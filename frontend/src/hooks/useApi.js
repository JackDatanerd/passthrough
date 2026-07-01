import { useState, useCallback } from 'react'
import api from '../lib/api'

export function useApi() {
  const [loading, setLoading] = useState(false)
  const [error,   setError  ] = useState(null)

  // execute: call any api method with any args
  // Returns the response data directly
  const execute = useCallback(async (apiCall) => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiCall()
      return res.data
    } catch (err) {
      const message = err.response?.data?.message || err.message || 'An error occurred'
      setError(message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  return { loading, error, execute }
}

// Usage example in a component:
// const { loading, error, execute } = useApi()
// const data = await execute(() => api.post('/scan', formData))
