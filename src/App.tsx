import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, type DragEvent } from 'react'
import CanvasHints from './components/CanvasHints'
import DevToolsPanel from './components/DevToolsPanel'
import DevToolsButton from './components/DevToolsButton'
import ProblemBriefPanel from './components/ProblemBriefPanel'
import HealthPanel from './components/HealthPanel'
import LatencyPanel from './components/LatencyPanel'
import LogPanel from './components/LogPanel'
import MobileGuard from './components/MobileGuard'
import RequestEdge from './components/RequestEdge'
import SettingsPanel from './components/SettingsPanel'
import SimulationControls from './components/SimulationControls'
import Sidebar from './components/Sidebar'
import SystemNode from './components/SystemNode'
import { DRAG_DATA_KEY, isComponentType } from './componentTypes'
import { useFlowStore } from './store'

function Canvas() {
  // Selected one field at a time: returning an object literal from a single
  // selector would allocate a new reference on every store read.
  const nodes = useFlowStore((state) => state.nodes)
  const edges = useFlowStore((state) => state.edges)
  const onNodesChange = useFlowStore((state) => state.onNodesChange)
  const onEdgesChange = useFlowStore((state) => state.onEdgesChange)
  const onConnect = useFlowStore((state) => state.onConnect)
  const addNode = useFlowStore((state) => state.addNode)
  const selectNode = useFlowStore((state) => state.selectNode)

  const { screenToFlowPosition, fitView } = useReactFlow()
  const canvasVersion = useFlowStore((state) => state.canvasVersion)

  // Presets are laid out for a desktop width. Without refitting, loading one
  // on a narrow screen leaves half the diagram off-canvas with no hint that it
  // is there.
  useEffect(() => {
    if (canvasVersion === 0) return
    const timer = setTimeout(
      () => fitView({ padding: 0.18, duration: 300, maxZoom: 1 }),
      60,
    )
    return () => clearTimeout(timer)
  }, [canvasVersion, fitView])

  const nodeTypes = useMemo(() => ({ systemNode: SystemNode }), [])
  const edgeTypes = useMemo(() => ({ requestEdge: RequestEdge }), [])

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    // Without preventDefault the browser refuses the drop outright.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()

      // Normally our own key; the text/plain fallback catches a drag that the
      // browser turned into a text-selection drag, so a stray selection can
      // never silently swallow a drop.
      const componentType =
        event.dataTransfer.getData(DRAG_DATA_KEY) ||
        event.dataTransfer.getData('text/plain').trim().toLowerCase()
      // Ignore drops that carry anything other than one of our palette cards.
      if (!isComponentType(componentType)) return

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      addNode(componentType, position)
    },
    [addNode, screenToFlowPosition],
  )

  return (
    <div
      className="relative h-full flex-1 overflow-hidden bg-slate-50"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        // onNodeClick fires only on a true click, never at the end of a drag.
        onNodeClick={(_, node) => selectNode(node.id)}
        onPaneClick={() => selectNode(null)}
        connectionMode={ConnectionMode.Loose}
        deleteKeyCode={['Delete', 'Backspace']}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls />
      </ReactFlow>
      <CanvasHints />
      <DevToolsButton />
      <ProblemBriefPanel />
      <SimulationControls />
      <SettingsPanel />
      <LogPanel />
      <HealthPanel />
      <LatencyPanel />
      <DevToolsPanel />
    </div>
  )
}

function App() {
  return (
    // screenToFlowPosition needs the provider to sit above the component
    // that calls it, so the provider wraps Canvas rather than living inside it.
    <MobileGuard>
      <ReactFlowProvider>
        <div className="relative flex h-screen w-screen">
          <Sidebar />
          <Canvas />
        </div>
      </ReactFlowProvider>
    </MobileGuard>
  )
}

export default App
