import { useCallback, useEffect, useRef, useState } from 'react'

// Tiny data hook: caching/dedup lives in api/fpl.js, this just manages
// component state, optional polling, and stale-response discard.
export function useAsync(fn, deps = [], { poll = 0, enabled = true } = {}) {
  const [state, set] = useState({ data: null, error: null, loading: enabled })
  const tick = useRef(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    if (!enabled) return
    const id = ++tick.current
    set(s => ({ ...s, loading: s.data == null }))
    Promise.resolve()
      .then(fn)
      .then(
        data => tick.current === id && set({ data, error: null, loading: false }),
        error => tick.current === id && set(s => ({ data: s.data, error, loading: false })),
      )
  }, [...deps, enabled])

  useEffect(() => {
    if (!enabled) {
      set({ data: null, error: null, loading: false })
      return
    }
    run()
    if (poll) {
      const iv = setInterval(run, poll)
      return () => clearInterval(iv)
    }
  }, [run, poll, enabled])

  return { ...state, reload: run }
}
