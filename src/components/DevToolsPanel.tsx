import { Check, ClipboardCopy, Download, Upload, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  buildFilteredExport,
  DEFAULT_FILTERS,
  filteredFilename,
  filterLogs,
  isDefaultFilters,
  parseSetup,
  type LogFilters,
} from '../devTools'
import { copyText, downloadJson } from '../exportSession'
import { saveNow } from '../persistence'
import { useFlowStore, type SystemNodeData } from '../store'

const label = 'text-[10px] font-semibold uppercase tracking-wide text-slate-400'
const input =
  'rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200'

function CheckRow<T extends string>({
  title,
  options,
  state,
  onChange,
}: {
  title: string
  options: { key: T; label: string }[]
  state: Record<T, boolean>
  onChange: (next: Record<T, boolean>) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={label}>{title}</span>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {options.map((option) => (
          <label
            key={option.key}
            className="flex items-center gap-1.5 text-[11px] text-slate-600"
          >
            <input
              type="checkbox"
              className="accent-blue-600"
              checked={state[option.key]}
              onChange={(event) =>
                onChange({ ...state, [option.key]: event.target.checked })
              }
            />
            {option.label}
          </label>
        ))}
      </div>
    </div>
  )
}

function DevToolsPanel() {
  const isOpen = useFlowStore((state) => state.isDevToolsOpen)
  const setOpen = useFlowStore((state) => state.setDevToolsOpen)
  const loadSetup = useFlowStore((state) => state.loadSetup)
  const logs = useFlowStore((state) => state.logs)
  const nodes = useFlowStore((state) => state.nodes)

  const [paste, setPaste] = useState('')
  const [importNote, setImportNote] = useState<
    { kind: 'error' | 'ok'; text: string } | null
  >(null)
  const [filters, setFilters] = useState<LogFilters>(DEFAULT_FILTERS)
  const [copied, setCopied] = useState(false)
  // A real clock rather than a counter, so the memo below has honest deps.
  const [now, setNow] = useState(() => Date.now())

  // The time-window filter is relative to now, so the count has to keep moving
  // even when nothing else changes.
  useEffect(() => {
    if (!isOpen || filters.lastSeconds === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isOpen, filters.lastSeconds])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  const matched = useMemo(
    () => filterLogs(logs, filters, now),
    [logs, filters, now],
  )

  if (!isOpen) return null

  const onLoad = () => {
    const result = parseSetup(paste)
    if (!result.ok) {
      setImportNote({ kind: 'error', text: result.error })
      return
    }
    if (
      !window.confirm(
        `Import this pasted setup?\n\nYour current diagram and history will be replaced by the ${result.nodes.length} nodes and ${result.edges.length} edges you pasted.`,
      )
    )
      return
    loadSetup(result.nodes, result.edges)
    saveNow()
    setImportNote({
      kind: 'ok',
      text:
        `Loaded ${result.nodes.length} nodes and ${result.edges.length} edges.` +
        (result.ignoredKeys.length
          ? ` Ignored extra field${result.ignoredKeys.length > 1 ? 's' : ''}: ${result.ignoredKeys.join(', ')}.`
          : ''),
    })
  }

  const snapshot = () =>
    JSON.stringify(
      buildFilteredExport(useFlowStore.getState(), filters),
      null,
      2,
    )

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-6">
      <div className="flex max-h-full w-[720px] max-w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
        <header className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <Wrench className="h-4 w-4 text-slate-400" />
          <span className="text-sm font-semibold text-slate-800">Dev Tools</span>
          <span className="text-[10px] text-slate-400">
            developer utilities — not part of the lesson
          </span>
          <button
            type="button"
            aria-label="Close dev tools"
            onClick={() => setOpen(false)}
            className="ml-auto rounded p-1 text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* ---------------- Import ---------------- */}
          <section className="border-b border-slate-200 px-4 py-3">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <Upload className="h-3.5 w-3.5 text-slate-400" />
              Import Test Setup
            </h3>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              Paste <code className="text-slate-600">{'{ nodes, edges }'}</code>.
              A full session export works too — anything beyond nodes and edges
              is ignored.
            </p>
            <textarea
              value={paste}
              onChange={(event) => {
                setPaste(event.target.value)
                setImportNote(null)
              }}
              spellCheck={false}
              placeholder='{ "nodes": [ ... ], "edges": [ ... ] }'
              className="mt-2 h-32 w-full resize-y rounded-md border border-slate-200 p-2 font-mono text-[10px] leading-relaxed text-slate-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={onLoad}
                className="rounded-md bg-blue-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-700"
              >
                Load Setup
              </button>
              {importNote && (
                <span
                  className={`text-[10px] leading-relaxed ${
                    importNote.kind === 'error' ? 'text-red-600' : 'text-green-700'
                  }`}
                >
                  {importNote.text}
                </span>
              )}
            </div>
          </section>

          {/* ---------------- Export ---------------- */}
          <section className="px-4 py-3">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <Download className="h-3.5 w-3.5 text-slate-400" />
              Export Filtered Logs
            </h3>

            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3">
              <CheckRow
                title="Outcome"
                options={[
                  { key: 'success', label: 'Success' },
                  { key: 'failed', label: 'Failed' },
                  { key: 'in_progress', label: 'In progress' },
                ]}
                state={filters.outcomes}
                onChange={(outcomes) => setFilters({ ...filters, outcomes })}
              />
              <CheckRow
                title="Method"
                options={[
                  { key: 'GET', label: 'GET' },
                  { key: 'POST', label: 'POST' },
                ]}
                state={filters.methods}
                onChange={(methods) => setFilters({ ...filters, methods })}
              />
              <CheckRow
                title="Cache result"
                options={[
                  { key: 'hit', label: 'Hit' },
                  { key: 'miss', label: 'Miss' },
                  { key: 'not_applicable', label: 'N/A' },
                ]}
                state={filters.cache}
                onChange={(cache) => setFilters({ ...filters, cache })}
              />
              <CheckRow
                title="Read freshness"
                options={[
                  { key: 'fresh', label: 'Fresh' },
                  { key: 'stale', label: 'Stale' },
                  { key: 'not_applicable', label: 'N/A' },
                ]}
                state={filters.freshness}
                onChange={(freshness) => setFilters({ ...filters, freshness })}
              />

              <label className="flex flex-col gap-1">
                <span className={label}>Resource key (exact)</span>
                <input
                  className={input}
                  value={filters.resourceKey}
                  placeholder="any"
                  onChange={(event) =>
                    setFilters({ ...filters, resourceKey: event.target.value })
                  }
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className={label}>Served by node</span>
                <select
                  className={input}
                  value={filters.servedByNodeId}
                  onChange={(event) =>
                    setFilters({ ...filters, servedByNodeId: event.target.value })
                  }
                >
                  <option value="">All</option>
                  {nodes.map((node) => {
                    const data = node.data as SystemNodeData
                    return (
                      <option key={node.id} value={node.id}>
                        {data.label} ({node.id})
                      </option>
                    )
                  })}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className={label}>Last N seconds</span>
                <input
                  className={input}
                  type="number"
                  min={1}
                  placeholder="no limit"
                  value={filters.lastSeconds ?? ''}
                  onChange={(event) =>
                    setFilters({
                      ...filters,
                      lastSeconds:
                        event.target.value === ''
                          ? null
                          : Math.max(1, Number(event.target.value)),
                    })
                  }
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className={label}>Max entries</span>
                <input
                  className={input}
                  type="number"
                  min={1}
                  placeholder="no cap"
                  value={filters.maxEntries ?? ''}
                  onChange={(event) =>
                    setFilters({
                      ...filters,
                      maxEntries:
                        event.target.value === ''
                          ? null
                          : Math.max(1, Number(event.target.value)),
                    })
                  }
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
              <span className="text-[11px] tabular-nums text-slate-600">
                <span className="font-semibold text-slate-800">
                  {matched.length}
                </span>{' '}
                of {logs.length} total log entries match these filters
                {isDefaultFilters(filters) && (
                  <span className="text-slate-400"> — full export</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setFilters(DEFAULT_FILTERS)}
                className="text-[10px] font-medium text-blue-600 underline-offset-2 hover:underline"
              >
                Reset filters
              </button>

              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadJson(filteredFilename(), snapshot())}
                  className="flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-700"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export Filtered (JSON)
                </button>
                <button
                  type="button"
                  aria-label="Copy filtered export to clipboard"
                  onClick={async () => setCopied(await copyText(snapshot()))}
                  className={`rounded-md border p-1.5 transition-colors ${
                    copied
                      ? 'border-green-200 bg-green-50 text-green-600'
                      : 'border-slate-200 text-slate-400 hover:bg-slate-100 hover:text-slate-700'
                  }`}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <ClipboardCopy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default DevToolsPanel
