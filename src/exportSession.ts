import type { Edge, Node } from '@xyflow/react'
import type { ComponentType } from './componentTypes'
import type { LogEntry, MetricSample, NodeSettings, SystemNodeData } from './store'

export type ExportedNode = {
  id: string
  componentType: ComponentType
  label: string
  position: { x: number; y: number }
  settings: NodeSettings
}

export type ExportedEdge = {
  id: string
  source: string
  target: string
}

export type SessionExport = {
  exportedAt: string
  nodes: ExportedNode[]
  edges: ExportedEdge[]
  logEntries: LogEntry[]
  /** Every resolved request this session, not just the logged tail. */
  metricSamples: MetricSample[]
}

/**
 * Snapshot of everything worth taking away from a session. The log entries go
 * out exactly as stored — every field and every event — so an export can be
 * analysed elsewhere without losing the per-hop timeline.
 */
export function buildSessionExport(state: {
  nodes: Node[]
  edges: Edge[]
  logs: LogEntry[]
  metrics: MetricSample[]
}): SessionExport {
  return {
    exportedAt: new Date().toISOString(),
    nodes: state.nodes.map((node) => {
      const data = node.data as SystemNodeData
      return {
        id: node.id,
        componentType: data.componentType,
        label: data.label,
        position: { x: node.position.x, y: node.position.y },
        // Whatever fields this node type carries, verbatim.
        settings: data.settings,
      }
    }),
    edges: state.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })),
    logEntries: state.logs,
    metricSamples: state.metrics,
  }
}

export const serializeSession = (session: SessionExport) =>
  JSON.stringify(session, null, 2)

/** `paperdraw-session-2026-09-10T14-22-05.json` — sortable and filename safe. */
export function sessionFilename(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/:/g, '-')
  return `paperdraw-session-${stamp}.json`
}

/** Hands the browser a Blob to save, then releases the object URL. */
export function downloadJson(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** Clipboard API where available, with a fallback for insecure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the textarea trick
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
