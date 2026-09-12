import { GraduationCap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { saveNow } from '../persistence'
import { PROBLEMS, type Difficulty } from '../problems'
import Badge, { type BadgeTone } from './Badge'
import { useFlowStore } from '../store'

const DIFFICULTY_TONES: Record<Difficulty, BadgeTone> = {
  Beginner: 'success',
  Intermediate: 'warning',
  Hard: 'danger',
}

function ProblemsMenu() {
  const loadProblem = useFlowStore((state) => state.loadProblem)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
          open
            ? 'bg-slate-100 text-slate-800'
            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
        }`}
      >
        <GraduationCap className="h-3.5 w-3.5" />
        Problems
      </button>

      {open && (
        // Opens upward: the control bar sits at the bottom of the canvas.
        <div className="absolute bottom-full left-1/2 z-30 mb-2 w-80 -translate-x-1/2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <p className="border-b border-slate-100 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Problems
          </p>
          <ul>
            {PROBLEMS.map((problem) => (
              <li key={problem.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Load the preset "${problem.title}"?\n\nYour current diagram and history will be replaced by this problem's starting setup.`,
                      )
                    )
                      return
                    // Stops auto-fire, clears log + counters, swaps the canvas,
                    // and opens the brief.
                    loadProblem(problem)
                    saveNow()
                    setOpen(false)
                  }}
                  className="flex w-full flex-col gap-1 border-b border-slate-100 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-blue-50/50"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-800">
                      {problem.title}
                    </span>
                    <Badge tone={DIFFICULTY_TONES[problem.difficulty]}>
                      {problem.difficulty}
                    </Badge>
                  </span>
                  <span className="text-[10px] leading-relaxed text-slate-500">
                    {problem.summary}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default ProblemsMenu
