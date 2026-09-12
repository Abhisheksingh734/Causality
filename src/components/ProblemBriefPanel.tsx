import { BookOpen, GraduationCap, GripHorizontal, Target, X } from 'lucide-react'
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { problemById, type Difficulty } from '../problems'
import { useFlowStore } from '../store'
import Badge, { type BadgeTone } from './Badge'
import ProblemGrading from './ProblemGrading'

const DIFFICULTY_TONES: Record<Difficulty, BadgeTone> = {
  Beginner: 'success',
  Intermediate: 'warning',
  Hard: 'danger',
}

const MARGIN = 16
/**
 * The control bar floats at the bottom and outranks this card, so the card has
 * to stop short of it. Without this the card could be dragged or resized tall
 * enough that its own buttons sat underneath the bar and stopped responding.
 */
const CONTROL_BAR_RESERVE = 84
/**
 * Above the control bar (z-40). The bar rides upward as docks open, so it can
 * end up crossing this card's row; when that happened the bar's rate slider
 * swallowed clicks meant for the card's own buttons. The card wins because it
 * is the thing the user just positioned, and it can be dragged aside — a
 * button that silently does nothing is the worse failure.
 */
const DEFAULT_SIZE = { width: 330, height: 560 }
const MIN_SIZE = { width: 280, height: 260 }
const MAX_SIZE = { width: 640, height: 760 }

type Tab = 'brief' | 'check'

/**
 * A floating card the user can move and resize. The brief and the grading flow
 * live in separate tabs rather than stacked in one column: sharing one short
 * scroll area meant every warning the grader added shoved the brief around and
 * left the whole thing awkward to read.
 */
function ProblemBriefPanel() {
  const isBriefOpen = useFlowStore((state) => state.isBriefOpen)
  const activeProblemId = useFlowStore((state) => state.activeProblemId)
  const setBriefOpen = useFlowStore((state) => state.setBriefOpen)
  const hasBaseline = useFlowStore((state) =>
    Boolean(activeProblemId && state.baselines[activeProblemId]),
  )
  const problem = problemById(activeProblemId)

  const cardRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null)
  const sizeRef = useRef<{ pointerX: number; pointerY: number; width: number; height: number } | null>(null)
  const [position, setPosition] = useState({ x: MARGIN, y: MARGIN })
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [dragging, setDragging] = useState(false)
  const [tab, setTab] = useState<Tab>('brief')

  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: position.x,
      y: position.y,
    }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragRef.current
    if (!start) return
    const card = cardRef.current
    const bounds = card?.offsetParent as HTMLElement | null
    let x = start.x + (event.clientX - start.pointerX)
    let y = start.y + (event.clientY - start.pointerY)
    if (bounds && card) {
      x = Math.min(Math.max(0, x), Math.max(0, bounds.clientWidth - card.offsetWidth))
      y = Math.min(
        Math.max(0, y),
        Math.max(0, bounds.clientHeight - card.offsetHeight - CONTROL_BAR_RESERVE),
      )
    }
    setPosition({ x, y })
  }

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    sizeRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: size.width,
      height: size.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = sizeRef.current
    if (!start) return
    setSize({
      width: Math.min(
        MAX_SIZE.width,
        Math.max(MIN_SIZE.width, start.width + (event.clientX - start.pointerX)),
      ),
      height: Math.min(
        MAX_SIZE.height,
        Math.max(MIN_SIZE.height, start.height + (event.clientY - start.pointerY)),
      ),
    })
  }

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    sizeRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  if (!isBriefOpen) return null

  const tabClass = (value: Tab) =>
    `flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-1.5 text-[11px] font-medium transition-colors ${
      tab === value
        ? 'border-blue-600 text-blue-700'
        : 'border-transparent text-slate-500 hover:text-slate-700'
    }`

  return (
    <aside
      ref={cardRef}
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        maxHeight: `calc(100% - ${MARGIN * 2 + CONTROL_BAR_RESERVE}px)`,
      }}
      className="absolute z-50 flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
    >
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        className={`flex select-none items-start justify-between gap-2 border-b border-slate-200 bg-slate-50/80 px-3 py-2.5 ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            <GraduationCap className="h-3.5 w-3.5 shrink-0" />
            Problem
            <GripHorizontal className="h-3 w-3 shrink-0 text-slate-300" />
          </span>
          {problem ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-800">
                {problem.title}
              </span>
              <Badge tone={DIFFICULTY_TONES[problem.difficulty]}>
                {problem.difficulty}
              </Badge>
            </span>
          ) : (
            <span className="text-sm font-semibold text-slate-500">
              Free play — no active problem
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label="Close brief"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setBriefOpen(false)}
          className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {problem && (
        <div className="flex shrink-0 border-b border-slate-200">
          <button type="button" onClick={() => setTab('brief')} className={tabClass('brief')}>
            <BookOpen className="h-3.5 w-3.5" />
            Brief
          </button>
          <button type="button" onClick={() => setTab('check')} className={tabClass('check')}>
            <Target className="h-3.5 w-3.5" />
            Check your work
            {hasBaseline && (
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
            )}
          </button>
        </div>
      )}

      {/* One pane at a time, each owning the full remaining height. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!problem ? (
          <p className="px-4 py-3 text-[11px] leading-relaxed text-slate-500">
            Pick something from <span className="font-medium">Problems</span> in
            the control bar to load a scenario and its brief. Until then the
            canvas is yours to play with.
          </p>
        ) : tab === 'brief' ? (
          <div className="flex flex-col gap-3 px-4 py-3">
            {problem.brief.map((paragraph, index) => (
              <p
                key={index}
                // pre-line keeps the a) b) c) sub-lines on their own rows.
                className="whitespace-pre-line text-[11px] leading-relaxed text-slate-600"
              >
                {paragraph}
              </p>
            ))}
            <p className="mt-1 rounded-md bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-400">
              Nothing is scored from this text. Use the{' '}
              <span className="font-medium">Check your work</span> tab, or read
              the numbers yourself in the Log, Health and Latency panels.
            </p>
          </div>
        ) : (
          <ProblemGrading problem={problem} />
        )}
      </div>

      <div
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        title="Drag to resize"
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
      >
        <svg viewBox="0 0 16 16" className="h-full w-full text-slate-300">
          <path d="M15 6 L6 15 M15 11 L11 15" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </div>
    </aside>
  )
}

export default ProblemBriefPanel
