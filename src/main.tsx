import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// React Flow's stylesheet must come after Tailwind's preflight so its
// node/handle/control styles are not reset away.
import '@xyflow/react/dist/style.css'
import App from './App.tsx'
import { initAnalytics, track } from './analytics'
import { startEdgeFlowSampler } from './edgeFlow'
import { hydrateFromStorage, startAutoSave } from './persistence'

// Restore before the first render so the canvas never flashes empty, and do it
// outside React so StrictMode's double-invoked effects cannot run it twice.
hydrateFromStorage()
startAutoSave()
startEdgeFlowSampler()

// Also out here for the same reason: one session, one app_loaded. Both calls
// are no-ops unless VITE_POSTHOG_KEY is set.
initAnalytics()
track('app_loaded')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
