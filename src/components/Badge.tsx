/**
 * Every small labelled pill in the app. Before this existed each one carried
 * its own padding, radius, size and weight, so OFFLINE, STALE, HIT and
 * BEGINNER all looked like they came from different products.
 */
export type BadgeTone =
  | 'neutral'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'write'
  | 'cache'

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600',
  success: 'bg-green-50 text-green-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-700',
  info: 'bg-blue-50 text-blue-700',
  write: 'bg-orange-50 text-orange-700',
  cache: 'bg-violet-50 text-violet-700',
}

/** Solid variants, for badges that sit on top of a node card rather than in a row. */
const SOLID: Record<BadgeTone, string> = {
  neutral: 'bg-slate-600 text-white',
  success: 'bg-green-600 text-white',
  warning: 'bg-amber-500 text-white',
  danger: 'bg-red-600 text-white',
  info: 'bg-blue-600 text-white',
  write: 'bg-orange-600 text-white',
  cache: 'bg-violet-600 text-white',
}

function Badge({
  tone = 'neutral',
  solid = false,
  uppercase = true,
  className = '',
  children,
}: {
  tone?: BadgeTone
  solid?: boolean
  uppercase?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
        uppercase ? 'uppercase tracking-wide' : ''
      } ${solid ? SOLID[tone] : TONES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

export default Badge
