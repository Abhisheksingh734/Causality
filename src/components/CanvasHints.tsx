import { ArrowLeft, Lightbulb, X } from 'lucide-react'
import { useState } from 'react'
import { useFlowStore, type SystemNodeData } from '../store'

/**
 * Which nudge the canvas currently warrants, derived from what the user has
 * actually built. 0 = empty canvas, 1..3 = the build-up path, 4 = nothing left
 * to suggest.
 */
function useHintStep() {
  return useFlowStore((state) => {
    if (state.nodes.length === 0) return 0

    const typeOf = (nodeId: string) =>
      (state.nodes.find((n) => n.id === nodeId)?.data as
        | SystemNodeData
        | undefined)?.componentType

    const linked = (a: string, b: string) =>
      state.edges.some((edge) => {
        const from = typeOf(edge.source)
        const to = typeOf(edge.target)
        return (from === a && to === b) || (from === b && to === a)
      })

    const clientServer = linked('client', 'server')
    const anyCompleted = Object.values(state.clientStats).some(
      (stats) => stats.completed > 0,
    )

    if (!clientServer || !anyCompleted) return 1
    if (!linked('server', 'database')) return 2
    if (!linked('server', 'cache')) return 3
    // Everything the walkthrough covers is wired up; point at what is left.
    if (!linked('client', 'loadbalancer') && !linked('database', 'database'))
      return 4
    return 5
  })
}

const HINTS: Record<number, { title: string; body: string }> = {
  1: {
    title: 'Connect a Client to a Server',
    body: 'Drag from a handle on one card to the other, then press Fire Request.',
  },
  2: {
    title: 'Add a Database and connect it',
    body: 'Reads now travel Server → Database and back. Watch requests get slower.',
  },
  3: {
    title: 'Add a Cache and connect it',
    body: 'Fire the same request twice — the second one should skip the database entirely.',
  },
  4: {
    title: 'Now try the rest',
    body: 'A Load Balancer spreads traffic over several Servers, and a Database set to Primary can hand reads to a Replica. Or pick something from Problems in the control bar for a scenario to fix.',
  },
}

function CanvasHints() {
  const step = useHintStep()
  // Onboarding nudges are for free play; a Problem has its own brief.
  const activeProblemId = useFlowStore((state) => state.activeProblemId)
  const [dismissed, setDismissed] = useState<number[]>([])

  if (activeProblemId) return null

  if (step === 0) {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-400">
          <ArrowLeft className="h-5 w-5 shrink-0 animate-pulse" strokeWidth={1.75} />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">
              Drag a Client and a Server from the left to get started
            </p>
            <p className="text-[11px] text-slate-400">
              Five components to build with — or pick a scenario from Problems
              in the control bar.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const hint = HINTS[step]
  if (!hint || dismissed.includes(step)) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-md items-start gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-lg">
        <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" strokeWidth={1.75} />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold text-slate-800">
            {step}. {hint.title}
          </span>
          <span className="text-[11px] leading-relaxed text-slate-500">
            {hint.body}
          </span>
        </div>
        <button
          type="button"
          aria-label="Dismiss hint"
          className="-mr-1 shrink-0 rounded p-1 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600"
          onClick={() => setDismissed((current) => [...current, step])}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

export default CanvasHints
