import { Network, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { SURFACE } from '../design'

/**
 * Tablets in landscape get through; phones and narrow portrait tablets meet the
 * guard.
 */
export const GUARD_BREAKPOINT = 768

const DISMISS_KEY = 'paperdraw-guard-snoozed-at'

/**
 * "Continue anyway" snoozes rather than dismisses. Hiding it for the whole
 * session meant one tap and the warning was gone for good, even after a long
 * stretch of fighting the layout on a phone; this brings it back periodically
 * so the nudge toward a real screen stays honest.
 */
export const SNOOZE_MS = 2 * 60 * 1000

/**
 * Returns the end of a still-running snooze, or null. A stored value that has
 * already lapsed is cleared here, so a reload after the window shows the guard
 * on the very first render rather than flashing the app first.
 *
 * sessionStorage throws in some privacy modes, so every access is guarded.
 */
function readActiveSnoozeEnd(): number | null {
  let at: number
  try {
    const raw = sessionStorage.getItem(DISMISS_KEY)
    if (raw === null) return null
    at = Number(raw)
  } catch {
    return null
  }
  if (!Number.isFinite(at)) return null
  const endsAt = at + SNOOZE_MS
  if (endsAt <= Date.now()) {
    writeSnoozedAt(null)
    return null
  }
  return endsAt
}

function writeSnoozedAt(at: number | null) {
  try {
    if (at === null) sessionStorage.removeItem(DISMISS_KEY)
    else sessionStorage.setItem(DISMISS_KEY, String(at))
  } catch {
    // A session that cannot remember the choice simply asks again.
  }
}

function GuardScreen({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-50 px-6">
      <div className={`flex w-full max-w-sm flex-col gap-4 ${SURFACE} px-5 py-6`}>
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-600">
            <Network className="h-5 w-5 text-white" strokeWidth={2} />
          </span>
          <div className="flex flex-col">
            <span className="text-base font-semibold leading-tight text-slate-800">
              Systems
            </span>
            <span className="text-[11px] leading-tight text-slate-400">
              System Design Canvas
            </span>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5">
          <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-red-600" />
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium leading-relaxed text-red-700">
              Screen too small. Use a laptop or desktop.
            </p>
            <p className="text-[11px] leading-relaxed text-red-600/80">
              Mobile version coming soon.
            </p>
          </div>
        </div>

        <div className="flex flex-col items-center gap-0.5">
          <button
            type="button"
            onClick={onContinue}
            className="text-[11px] text-slate-400 underline-offset-2 transition-colors hover:text-slate-600 hover:underline"
          >
            Continue anyway
          </button>
          <span className="text-[10px] text-slate-400">
            Things may not work as expected.
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Replaces the app outright on narrow viewports rather than overlaying it, so
 * nothing underneath has to cope with a size it was never built for.
 */
function MobileGuard({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? GUARD_BREAKPOINT : window.innerWidth,
  )
  const [snoozeEndsAt, setSnoozeEndsAt] = useState(readActiveSnoozeEnd)

  // The timer only exists so the guard comes back while the user is sitting on
  // the page; a reload is handled by the read above instead.
  useEffect(() => {
    if (snoozeEndsAt === null) return
    const timer = setTimeout(
      () => {
        writeSnoozedAt(null)
        setSnoozeEndsAt(null)
      },
      Math.max(0, snoozeEndsAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [snoozeEndsAt])

  useEffect(() => {
    const sync = () => {
      const next = window.innerWidth
      setWidth(next)
      // Growing back to a usable width ends the dismissal. Coming back down to
      // a small screen later is a new situation and deserves to be told about
      // again, rather than inheriting a "Continue anyway" from a size the user
      // is no longer at. Runs on mount too, so the same holds after a reload
      // that lands wide. Setting null when it is already null re-renders
      // nothing.
      if (next >= GUARD_BREAKPOINT) {
        writeSnoozedAt(null)
        setSnoozeEndsAt(null)
      }
    }
    sync()
    window.addEventListener('resize', sync)
    // Some browsers report the pre-rotation width during orientationchange, so
    // re-read on the next frame as well.
    const onOrientation = () => {
      sync()
      requestAnimationFrame(sync)
    }
    window.addEventListener('orientationchange', onOrientation)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', onOrientation)
    }
  }, [])

  // Width wins over the snooze: once there is room, the app just runs.
  if (width >= GUARD_BREAKPOINT || snoozeEndsAt !== null) return <>{children}</>

  return (
    <GuardScreen
      onContinue={() => {
        const now = Date.now()
        writeSnoozedAt(now)
        setSnoozeEndsAt(now + SNOOZE_MS)
      }}
    />
  )
}

export default MobileGuard
