import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { DragEvent } from 'react'
import {
  COMPONENT_TYPES,
  DRAG_DATA_KEY,
  type ComponentType,
} from '../componentTypes'
import { useFlowStore } from '../store'

function Sidebar() {
  const isOpen = useFlowStore((state) => state.isSidebarOpen)
  const setOpen = useFlowStore((state) => state.setSidebarOpen)

  const onDragStart = (event: DragEvent<HTMLDivElement>, type: ComponentType) => {
    event.dataTransfer.setData(DRAG_DATA_KEY, type)
    // Mirrored into text/plain so the drop handler's fallback can recover it.
    event.dataTransfer.setData('text/plain', type)
    event.dataTransfer.effectAllowed = 'move'
  }

  if (!isOpen) {
    // Collapsed to nothing but a way back, so the canvas gets the full width.
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Show components"
        aria-label="Show components"
        className="absolute left-3 top-3 z-30 flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50"
      >
        <PanelLeftOpen className="h-3.5 w-3.5 text-slate-400" />
        Components
      </button>
    )
  }

  return (
    <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="flex flex-col">
          <h1 className="text-sm font-semibold text-slate-800">Components</h1>
          <p className="mt-0.5 text-[11px] text-slate-500">Drag onto the canvas</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          title="Hide components"
          aria-label="Hide components"
          className="shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col gap-2 p-3">
        {COMPONENT_TYPES.map(({ type, label, Icon }) => (
          <div
            key={type}
            draggable
            onDragStart={(event) => onDragStart(event, type)}
            // select-none matters: clicking the card first puts a text
            // selection on the label, and the next press-and-drag then drags
            // that selection instead of the card. The browser fills the
            // dataTransfer with text/plain, our componentType key comes back
            // empty, and the drop is silently ignored — the node never lands.
            className="flex cursor-grab select-none items-center gap-2.5 rounded-md border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50/40 active:cursor-grabbing"
          >
            <Icon className="h-5 w-5 text-slate-500" strokeWidth={1.75} />
            <span className="text-xs font-medium">{label}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}

export default Sidebar
