import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, type TopologyResponse, type EventLogEntry } from '../api'
import { useSSE } from '../hooks/useSSE'
import { PageLoading, EmptyState } from '../components/StateViews'

// ==================== Layout ====================

const COL_X = {
  producers: 40,
  inputs: 320,
  listeners: 640,
  outputs: 960,
}
const ROW_HEIGHT = 80
const PULSE_MS = 800

function buildGraph(topology: TopologyResponse): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []

  const typeNames = topology.eventTypes.map((e) => e.name)
  const externalSet = new Set(
    topology.eventTypes.filter((e) => e.external).map((e) => e.name),
  )
  const descriptionByType = new Map(
    topology.eventTypes.map((e) => [e.name, e.description ?? '']),
  )

  function eventNodeClassName(type: string): string {
    const base = 'flow-event-node'
    return externalSet.has(type) ? `${base} flow-event-external` : base
  }

  function eventLabel(type: string) {
    const desc = descriptionByType.get(type)
    return (
      <span title={desc || type}>{type}</span>
    )
  }

  // Helper to vertically center a column with fewer rows against the event columns.
  const eventRowCount = typeNames.length
  function columnYOffset(rowCount: number): number {
    return Math.max(0, ((eventRowCount - rowCount) * ROW_HEIGHT) / 2)
  }

  // Column 0 — producers (pure event sources). Vertically centered.
  const producers = topology.producers ?? []
  const producerYOffset = columnYOffset(producers.length)
  producers.forEach((p, i) => {
    const classes = ['flow-producer-node']
    if (p.emitsWildcard) classes.push('flow-producer-emit-wildcard')
    nodes.push({
      id: `producer:${p.name}`,
      type: 'default',
      data: { label: p.name },
      position: { x: COL_X.producers, y: 20 + producerYOffset + i * ROW_HEIGHT },
      className: classes.join(' '),
      sourcePosition: 'right' as any,
      targetPosition: 'left' as any,
    })
  })

  // Column 1 — event types as subscribe sources (left-side events)
  typeNames.forEach((type, i) => {
    nodes.push({
      id: `event-in:${type}`,
      type: 'default',
      data: { label: eventLabel(type) },
      position: { x: COL_X.inputs, y: 20 + i * ROW_HEIGHT },
      className: eventNodeClassName(type),
      sourcePosition: 'right' as any,
      targetPosition: 'left' as any,
    })
  })

  // Column 3 — same event types as emit targets (right-side events), aligned vertically
  typeNames.forEach((type, i) => {
    nodes.push({
      id: `event-out:${type}`,
      type: 'default',
      data: { label: eventLabel(type) },
      position: { x: COL_X.outputs, y: 20 + i * ROW_HEIGHT },
      className: eventNodeClassName(type),
      sourcePosition: 'right' as any,
      targetPosition: 'left' as any,
    })
  })

  // Column 2 — listeners, vertically centered against the event columns.
  const listenerYOffset = columnYOffset(topology.listeners.length)
  topology.listeners.forEach((l, i) => {
    const classes = ['flow-listener-node']
    if (l.subscribesWildcard) classes.push('flow-listener-sub-wildcard')
    if (l.emitsWildcard) classes.push('flow-listener-emit-wildcard')
    nodes.push({
      id: `listener:${l.name}`,
      type: 'default',
      data: { label: l.name },
      position: { x: COL_X.listeners, y: 20 + listenerYOffset + i * ROW_HEIGHT },
      className: classes.join(' '),
      sourcePosition: 'right' as any,
      targetPosition: 'left' as any,
    })
  })

  // Producer → event-in edges (inject). Wildcard producers get aura instead.
  for (const p of producers) {
    if (p.emitsWildcard) continue
    for (const e of p.emits) {
      edges.push({
        id: `inject:${p.name}->${e}`,
        source: `producer:${p.name}`,
        target: `event-in:${e}`,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#a371f7', strokeWidth: 1.5 },
      })
    }
  }

  // Subscribe edges: left-side event → listener (skipped for wildcard subscribers — aura instead)
  for (const l of topology.listeners) {
    if (l.subscribesWildcard) continue
    for (const s of l.subscribes) {
      edges.push({
        id: `sub:${s}->${l.name}`,
        source: `event-in:${s}`,
        target: `listener:${l.name}`,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#58a6ff', strokeWidth: 1.5 },
      })
    }
  }

  // Emit edges: listener → right-side event (skipped for wildcard emitters — aura instead)
  for (const l of topology.listeners) {
    if (l.emitsWildcard) continue
    for (const e of l.emits) {
      edges.push({
        id: `emit:${l.name}->${e}`,
        source: `listener:${l.name}`,
        target: `event-out:${e}`,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#3fb950', strokeWidth: 1.5, strokeDasharray: '4 3' },
      })
    }
  }

  return { nodes, edges }
}

// ==================== Component ====================

export function AutomationFlowSection() {
  const [topology, setTopology] = useState<TopologyResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Track which event types are currently pulsing (both left+right columns light up)
  const [pulsingTypes, setPulsingTypes] = useState<Set<string>>(new Set())
  const pulseTimers = useRef<Map<string, number>>(new Map())

  // Fetch topology
  useEffect(() => {
    api.topology.get()
      .then(setTopology)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [])

  // Pulse both sides of the event type when an event arrives
  const handleSSE = useCallback((entry: EventLogEntry) => {
    const type = entry.type
    setPulsingTypes((prev) => {
      if (prev.has(type)) return prev
      const next = new Set(prev)
      next.add(type)
      return next
    })
    const existing = pulseTimers.current.get(type)
    if (existing) window.clearTimeout(existing)
    const t = window.setTimeout(() => {
      setPulsingTypes((prev) => {
        if (!prev.has(type)) return prev
        const next = new Set(prev)
        next.delete(type)
        return next
      })
      pulseTimers.current.delete(type)
    }, PULSE_MS)
    pulseTimers.current.set(type, t as unknown as number)
  }, [])

  useSSE({
    url: '/api/events/stream',
    onMessage: handleSSE,
  })

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      pulseTimers.current.forEach((t) => window.clearTimeout(t))
      pulseTimers.current.clear()
    }
  }, [])

  // Build graph + overlay pulse class on both columns of a pulsing event type
  const { nodes, edges } = useMemo(() => {
    if (!topology) return { nodes: [] as Node[], edges: [] as Edge[] }
    const g = buildGraph(topology)
    g.nodes = g.nodes.map((n) => {
      const match = /^event-(?:in|out):(.+)$/.exec(n.id)
      if (match && pulsingTypes.has(match[1])) {
        return { ...n, className: `${n.className ?? ''} flow-pulse` }
      }
      return n
    })
    return g
  }, [topology, pulsingTypes])

  if (loadError) {
    return <EmptyState title="Failed to load topology" description={loadError} />
  }
  if (!topology) return <PageLoading />

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="rounded-lg border border-border/50 bg-bg-secondary/50 px-4 py-3">
        <p className="text-[13px] text-text-muted leading-relaxed">
          Alice's async lifecycle as a graph. Four columns from left to right: producers (pure event sources like
          cron-engine and connector gateways), event types as subscribe sources, registered listeners, and the
          same event types as emit targets. Same event sits at the same row on both event columns. Purple solid
          arrows are injections from producers, blue solid arrows are subscriptions, dashed green arrows are
          emissions. A glowing halo on a listener means it accepts (left) or produces (right) any registered
          event type. Both event columns pulse in real time when an event of that type fires.
        </p>
      </div>

      <div className="flex-1 min-h-0 rounded-lg border border-border bg-bg overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background color="#30363d" gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  )
}
