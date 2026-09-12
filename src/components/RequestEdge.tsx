import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { EMPTY_FLOW, useEdgeFlowStore } from '../edgeFlow'
import { TRAVEL_PHASES, useFlowStore, type InFlightRequest } from '../store'

/** How long departing dots keep animating while the flow effect fades in. */
const CROSSFADE_MS = 320

const GET_COLOR = '#2563eb'
const POST_COLOR = '#ea580c'
const CACHE_COLOR = '#7c3aed'
const OK_COLOR = '#16a34a'
const MISS_COLOR = '#d97706'
/** A stale answer is a correctness failure, not a warning. */
const STALE_COLOR = '#dc2626'
const SYNC_COLOR = '#64748b'

type PacketStyle = {
  shape: 'circle' | 'diamond'
  color: string
  label: string
  small?: boolean
  dashed?: boolean
}

/**
 * Circle = something travelling out; diamond = an answer coming back.
 * Colour names the tier: blue GET / read, orange POST / write, violet cache
 * traffic, green a good answer, amber a miss, slate a background flush.
 */
function packetStyle(request: InFlightRequest): PacketStyle {
  const isGet = request.method === 'GET'
  switch (request.phase) {
    case 'lb-outbound':
    case 'lb-to-server':
      // Still the same request travelling out; the balancer is a waypoint,
      // not a different kind of traffic.
      return {
        shape: 'circle',
        color: isGet ? GET_COLOR : POST_COLOR,
        label: request.method,
      }
    case 'server-to-lb':
    case 'lb-inbound':
      return { shape: 'diamond', color: OK_COLOR, label: '200' }
    case 'outbound':
      return {
        shape: 'circle',
        color: isGet ? GET_COLOR : POST_COLOR,
        label: request.method,
      }
    case 'cache-outbound':
      return { shape: 'circle', color: CACHE_COLOR, label: 'LOOKUP' }
    case 'cache-update':
      return {
        shape: 'circle',
        color: CACHE_COLOR,
        label:
          request.cacheAction === 'invalidate'
            ? 'INVALIDATE'
            : request.cacheAction === 'write'
              ? 'WRITE'
              : 'POPULATE',
      }
    case 'cache-inbound':
      // Returning from a populate/write/invalidate rather than a lookup.
      if (request.cacheAction)
        return { shape: 'diamond', color: OK_COLOR, label: 'OK' }
      return request.cacheOutcome === 'hit'
        ? { shape: 'diamond', color: OK_COLOR, label: 'HIT' }
        : { shape: 'diamond', color: MISS_COLOR, label: 'MISS' }
    case 'replica-outbound':
      return { shape: 'circle', color: '#4f46e5', label: 'READ' }
    case 'replica-inbound':
      // The whole point of the feature: a stale answer looks different.
      return request.readFreshness === 'stale'
        ? { shape: 'diamond', color: STALE_COLOR, label: 'STALE' }
        : { shape: 'diamond', color: OK_COLOR, label: 'DATA' }
    case 'db-outbound':
      return {
        shape: 'circle',
        color: isGet ? GET_COLOR : POST_COLOR,
        label: isGet ? 'READ' : 'WRITE',
      }
    case 'db-inbound':
      return request.readFreshness === 'stale'
        ? { shape: 'diamond', color: MISS_COLOR, label: 'STALE' }
        : { shape: 'diamond', color: OK_COLOR, label: 'DATA' }
    case 'sync-outbound':
      // Background write-back flush: deliberately quiet and visually secondary.
      return {
        shape: 'circle',
        color: SYNC_COLOR,
        label: 'SYNC',
        small: true,
        dashed: true,
      }
    default:
      // Carries the staleness all the way back to the client.
      return request.readFreshness === 'stale'
        ? { shape: 'diamond', color: STALE_COLOR, label: '200 STALE' }
        : { shape: 'diamond', color: OK_COLOR, label: '200' }
  }
}

type PacketProps = {
  request: InFlightRequest
  path: string
  /** True when the packet travels along the path in its drawn direction. */
  forward: boolean
}

/**
 * One travelling packet, animated with SMIL along the edge's own bezier path
 * so it tracks the curve exactly and stays smooth at any zoom level.
 */
function RequestPacket({ request, path, forward }: PacketProps) {
  const motionRef = useRef<SVGAnimateMotionElement>(null)

  // begin="indefinite" + beginElement() rather than begin="0s": a SMIL
  // element inserted into an already-running document would otherwise measure
  // its start against the document timeline and jump straight to the end.
  useEffect(() => {
    motionRef.current?.beginElement()
  }, [])

  const style = packetStyle(request)
  const radius = style.small ? 4 : 6

  return (
    <g>
      {style.shape === 'diamond' ? (
        <rect
          x={-5.5}
          y={-5.5}
          width={11}
          height={11}
          transform="rotate(45)"
          fill={style.color}
          stroke="#ffffff"
          strokeWidth={1.5}
        />
      ) : (
        <circle
          r={radius}
          fill={style.color}
          stroke="#ffffff"
          strokeWidth={1.5}
          strokeDasharray={style.dashed ? '2 2' : undefined}
        />
      )}
      <text
        x={radius + 4}
        y={-7}
        fontSize={style.small ? 8 : 9}
        fontWeight={600}
        fill={style.color}
        stroke="#ffffff"
        strokeWidth={3}
        paintOrder="stroke"
      >
        {style.label}
      </text>
      <animateMotion
        ref={motionRef}
        dur={`${request.legDurationMs}ms`}
        path={path}
        begin="indefinite"
        fill="freeze"
        calcMode="linear"
        keyPoints={forward ? '0;1' : '1;0'}
        keyTimes="0;1"
      />
    </g>
  )
}

function RequestEdge({
  id,
  selected,
  source,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const deleteEdge = useFlowStore((s) => s.deleteEdge)
  const mode = useEdgeFlowStore((s) => s.edges[id]?.mode ?? EMPTY_FLOW.mode)
  const requestsPerSecond = useEdgeFlowStore(
    (s) => s.edges[id]?.requestsPerSecond ?? EMPTY_FLOW.requestsPerSecond,
  )

  /*
   * Subscribing to the whole requests array re-rendered every edge on every
   * store write — and there are well over a dozen writes per request. This
   * selector returns a short string that only changes when the dots actually
   * on THIS edge change, so unrelated log and counter writes cost nothing.
   */
  const signature = useFlowStore((state) => {
    let key = ''
    for (const r of state.requests) {
      if (r.currentEdgeId === id && TRAVEL_PHASES.includes(r.phase)) {
        key += r.id + ':' + r.phase + '|'
      }
    }
    return key
  })

  // Read straight from the store: the signature subscription above is what
  // guarantees this component re-renders whenever this list would differ.
  void signature
  const travelling = useFlowStore
    .getState()
    .requests.filter(
      (r) => r.currentEdgeId === id && TRAVEL_PHASES.includes(r.phase),
    )

  // Keep the last individual dots on screen briefly while the flow effect
  // fades in, so the switch reads as a hand-off rather than a pop.
  const [dotsMounted, setDotsMounted] = useState(mode !== 'flow')
  const [lastMode, setLastMode] = useState(mode)
  if (mode !== lastMode) {
    setLastMode(mode)
    // Coming back from flow: dots reappear immediately.
    if (mode === 'dots') setDotsMounted(true)
  }
  useEffect(() => {
    if (mode !== 'flow') return
    const timer = setTimeout(() => setDotsMounted(false), CROSSFADE_MS)
    return () => clearTimeout(timer)
  }, [mode])

  const isFlow = mode === 'flow'
  // Busier edges flow faster and glow harder, but never stop moving.
  const dashDurationMs = Math.max(260, 1100 - requestsPerSecond * 42)
  const glowOpacity = Math.min(0.42, 0.14 + requestsPerSecond * 0.018)
  const glowWidth = 6 + Math.min(6, requestsPerSecond * 0.35)

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />

      {isFlow && (
        <g className="rf-fade-in">
          <path
            className="rf-flow-glow"
            d={edgePath}
            stroke="#3b82f6"
            strokeWidth={glowWidth}
            opacity={glowOpacity}
          />
          <path
            className="rf-flow-dash"
            d={edgePath}
            stroke="#2563eb"
            strokeWidth={3}
            style={{ animationDuration: `${dashDurationMs}ms` }}
          />
        </g>
      )}

      {dotsMounted && (
        <g
          style={{
            opacity: isFlow ? 0 : 1,
            transition: `opacity ${CROSSFADE_MS}ms ease-out`,
          }}
        >
          {travelling.map((request) => (
            <RequestPacket
              // Keyed by phase so the element remounts on each leg, which
              // restarts the animation instead of silently reusing the old one.
              key={`${request.id}-${request.phase}`}
              request={request}
              path={edgePath}
              forward={request.legFromNodeId === source}
            />
          ))}
        </g>
      )}

      {selected && (
        // Tap an edge to select it, then tap this. Works without a keyboard.
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Delete this connection"
            title="Delete this connection"
            onClick={() => deleteEdge(id)}
            className="nodrag nopan pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-red-200 bg-white text-red-600 shadow-sm transition-colors hover:bg-red-50"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <X className="h-3 w-3" strokeWidth={3} />
          </button>
        </EdgeLabelRenderer>
      )}

      {isFlow && !selected && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan rf-fade-in pointer-events-none absolute rounded-full border border-blue-200 bg-white/90 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-blue-700 shadow-sm"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            ~{requestsPerSecond} req/s
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export default RequestEdge
