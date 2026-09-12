import {
  Database,
  MonitorSmartphone,
  Server,
  Split,
  Zap,
  type LucideIcon,
} from 'lucide-react'

/** The building blocks a user can place on the canvas. */
export type ComponentType =
  | 'client'
  | 'loadbalancer'
  | 'server'
  | 'cache'
  | 'database'

export type ComponentMeta = {
  type: ComponentType
  label: string
  Icon: LucideIcon
}

/** Ordered list — drives the sidebar palette. */
export const COMPONENT_TYPES: ComponentMeta[] = [
  { type: 'client', label: 'Client', Icon: MonitorSmartphone },
  { type: 'loadbalancer', label: 'Load Balancer', Icon: Split },
  { type: 'server', label: 'Server', Icon: Server },
  { type: 'cache', label: 'Cache', Icon: Zap },
  { type: 'database', label: 'Database', Icon: Database },
]

/** Keyed lookup — drives node rendering and validates dropped payloads. */
export const COMPONENT_META = Object.fromEntries(
  COMPONENT_TYPES.map((meta) => [meta.type, meta]),
) as Record<ComponentType, ComponentMeta>

export function isComponentType(value: string): value is ComponentType {
  return value in COMPONENT_META
}

/** The MIME-ish key used for the HTML5 drag payload. */
export const DRAG_DATA_KEY = 'application/reactflow'
