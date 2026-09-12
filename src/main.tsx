import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// React Flow's stylesheet must come after Tailwind's preflight so its
// node/handle/control styles are not reset away.
import '@xyflow/react/dist/style.css'
import App from './App.tsx'
import { startEdgeFlowSampler } from './edgeFlow'
import { hydrateFromStorage, startAutoSave } from './persistence'

// Restore before the first render so the canvas never flashes empty, and do it
// outside React so StrictMode's double-invoked effects cannot run it twice.
hydrateFromStorage()
startAutoSave()
startEdgeFlowSampler()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
