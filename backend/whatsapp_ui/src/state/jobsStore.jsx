import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

/**
 * Global, route-stable job tracker.
 *
 * Why this exists:
 *   Pages (WhatsApp/Discord) track their in-flight analyses with
 *   useState. When the user navigates to a different page, React unmounts
 *   the page and its local state is destroyed - the spinner disappears,
 *   the progress message disappears, and on return the user has no idea
 *   whether the backend is still working or already finished.
 *
 *   This store lives at the App level, so it survives route changes.
 *   It also persists the "currently running job" set to localStorage so
 *   a full page reload (or refresh) still restores the same state.
 *
 *   Summaries themselves are still owned by the page-level summaries
 *   state (and persisted separately under contextai_summaries). This
 *   store only owns the *transient* running/loading flags + the
 *   human-readable status message.
 */

const STORAGE_KEY = 'contextai_active_jobs_v1'

const JobsContext = createContext(null)

// In-process registry of in-flight background tasks keyed by job id. A page
// registers a runner once (idempotently). If a user reloads mid-analysis,
// we *don't* try to resume the old network request - we just leave the
// status flag set until the next page action or a fresh "Check status" call.
const runners = new Map()

function loadInitial() {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

export function JobsProvider({ children }) {
  const [jobs, setJobs] = useState(loadInitial)

  // Keep localStorage in sync so a reload restores the same flags.
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs))
    } catch (_) {
      // Ignore quota errors - this is a non-critical mirror.
    }
  }, [jobs])

  const startJob = useCallback((id, message) => {
    setJobs((prev) => ({
      ...prev,
      [id]: {
        id,
        message: message || 'Working...',
        startedAt: Date.now(),
        status: 'running',
      },
    }))
  }, [])

  const updateMessage = useCallback((id, message) => {
    setJobs((prev) => {
      if (!prev[id]) return prev
      return { ...prev, [id]: { ...prev[id], message } }
    })
  }, [])

  const completeJob = useCallback((id) => {
    setJobs((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    setJobs({})
  }, [])

  /**
   * Register a runner for `id`. The same `id` may be restarted multiple
   * times (e.g. user re-clicks Analyze); only one runner is ever live
   * per id. The `fn` should return a promise - errors are caught and
   * surfaced via updateMessage + completeJob.
   */
  const registerRunner = useCallback(
    (id, fn, message) => {
      // If a runner is already registered, don't double-run.
      if (runners.has(id)) return () => {}
      let cancelled = false
      startJob(id, message)

      const promise = Promise.resolve()
        .then(() => fn())
        .then(() => {
          if (cancelled) return
          completeJob(id)
        })
        .catch((err) => {
          if (cancelled) return
          console.error(`Job ${id} failed`, err)
          updateMessage(id, `⚠️ ${err?.message || 'Failed'}`)
          // Leave the entry visible for a few seconds, then clear it.
          setTimeout(() => {
            completeJob(id)
          }, 4000)
        })

      runners.set(id, { promise, cancel: () => { cancelled = true } })
      return () => {
        cancelled = true
        runners.delete(id)
        completeJob(id)
      }
    },
    [startJob, completeJob, updateMessage]
  )

  const value = { jobs, startJob, updateMessage, completeJob, clearAll, registerRunner }
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>
}

export function useJobs() {
  const ctx = useContext(JobsContext)
  if (!ctx) {
    throw new Error('useJobs must be used inside <JobsProvider>')
  }
  return ctx
}
