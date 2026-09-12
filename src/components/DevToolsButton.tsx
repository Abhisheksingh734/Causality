import { Wrench } from 'lucide-react'
import { useFlowStore } from '../store'
import { SIDE_PANEL_WIDTH } from './panelLayout'

/**
 * Tucked into the top-right corner and deliberately muted: this is a developer
 * utility, not something someone working through a Problem needs to notice.
 */
function DevToolsButton() {
  const isOpen = useFlowStore((state) => state.isDevToolsOpen)
  const setOpen = useFlowStore((state) => state.setDevToolsOpen)
  // The settings panel occupies this same corner, and its close button sat
  // exactly under this one. Step aside rather than fight over the pixel.
  const isSettingsOpen = useFlowStore((state) => state.selectedNodeId !== null)

  return (
    <button
      type="button"
      title="Dev Tools — import a setup, export filtered logs"
      aria-label="Dev Tools"
      onClick={() => setOpen(!isOpen)}
      style={{ right: (isSettingsOpen ? SIDE_PANEL_WIDTH : 0) + 12 }}
      className={`absolute top-3 z-20 rounded-md border p-1.5 transition-all duration-200 ${
        isOpen
          ? 'border-slate-300 bg-slate-100 text-slate-700'
          : 'border-transparent text-slate-300 hover:border-slate-200 hover:bg-white hover:text-slate-500'
      }`}
    >
      <Wrench className="h-3.5 w-3.5" />
    </button>
  )
}

export default DevToolsButton
