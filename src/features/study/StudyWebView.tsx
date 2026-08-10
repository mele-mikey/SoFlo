import { ChevronLeft, Maximize2, Minus, Plus, RotateCcw, Search, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import type { FlashcardSetDetail, StudyWebDetail } from '../../lib/types'

type Viewport = { x: number; y: number; scale: number }

interface StudyWebViewProps {
  web: StudyWebDetail
  set: FlashcardSetDetail
  aiEnabled: boolean
  onBack: () => void
  onRegenerate: () => void
  onStudyCard: (cardId: string) => void
}

const nodeWidth = 244
const collapsedHeight = 68

export function StudyWebView({ web, set, aiEnabled, onBack, onRegenerate, onStudyCard }: StudyWebViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 80, scale: 0.8 })
  const [nodes, setNodes] = useState(() => new Map(web.nodes.map((node) => [node.cardId, node])))
  const nodesRef = useRef(nodes)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const dragRef = useRef<{ kind: 'canvas' | 'node'; cardId?: string; x: number; y: number; viewport: Viewport; node?: { x: number; y: number } } | null>(null)
  const cards = useMemo(() => new Map(set.cards.map((card) => [card.id, card])), [set.cards])
  const related = useMemo(() => selected ? new Set(web.relationships.flatMap((edge) => edge.sourceCardId === selected ? [edge.targetCardId] : edge.targetCardId === selected ? [edge.sourceCardId] : [])) : new Set<string>(), [selected, web.relationships])
  const bounds = useMemo(() => {
    const values = [...nodes.values()]
    if (!values.length) return { minX: 0, minY: 0, width: 1000, height: 760 }
    const minX = Math.min(...values.map((node) => node.x)) - 180
    const minY = Math.min(...values.map((node) => node.y)) - 140
    const maxX = Math.max(...values.map((node) => node.x + nodeWidth)) + 220
    const maxY = Math.max(...values.map((node) => node.y + (expanded === node.cardId ? 260 : collapsedHeight))) + 200
    return { minX, minY, width: Math.max(900, maxX - minX), height: Math.max(700, maxY - minY) }
  }, [expanded, nodes])
  const fit = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const scale = Math.max(0.34, Math.min(1, Math.min((rect.width - 96) / bounds.width, (rect.height - 96) / bounds.height)))
    setViewport({ scale, x: (rect.width - bounds.width * scale) / 2 - bounds.minX * scale, y: (rect.height - bounds.height * scale) / 2 - bounds.minY * scale })
  }
  useEffect(() => { const frame = requestAnimationFrame(fit); return () => cancelAnimationFrame(frame) }, [web.id])
  useEffect(() => { const next = new Map(web.nodes.map((node) => [node.cardId, node])); nodesRef.current = next; setNodes(next) }, [web.nodes])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        const factor = event.deltaY < 0 ? 1.1 : 0.9
        setViewport((current) => {
          const scale = Math.max(0.28, Math.min(1.7, current.scale * factor))
          const x = event.clientX - rect.left
          const y = event.clientY - rect.top
          return { scale, x: x - (x - current.x) * (scale / current.scale), y: y - (y - current.y) * (scale / current.scale) }
        })
      } else setViewport((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
    }
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => canvas.removeEventListener('wheel', wheel)
  }, [])
  const move = (event: PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'canvas') setViewport({ ...drag.viewport, x: drag.viewport.x + event.clientX - drag.x, y: drag.viewport.y + event.clientY - drag.y })
    if (drag.kind === 'node' && drag.cardId && drag.node) {
      const x = drag.node.x + (event.clientX - drag.x) / drag.viewport.scale
      const y = drag.node.y + (event.clientY - drag.y) / drag.viewport.scale
      setNodes((current) => { const next = new Map(current); const node = next.get(drag.cardId!); if (node) next.set(drag.cardId!, { ...node, x, y, manuallyPositioned: true }); nodesRef.current = next; return next })
    }
  }
  const stop = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.kind === 'node' && drag.cardId) {
      const node = nodesRef.current.get(drag.cardId)
      if (node) void api.saveStudyWebNodePosition({ studyWebId: web.id, cardId: node.cardId, x: node.x, y: node.y })
    }
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
  }
  const startCanvasDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return
    if ((event.target as HTMLElement).closest('.study-web-node, .study-web-control, .study-web-search')) return
    event.preventDefault()
    dragRef.current = { kind: 'canvas', x: event.clientX, y: event.clientY, viewport }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  const startNodeDrag = (event: React.PointerEvent<HTMLButtonElement>, cardId: string) => {
    if (event.button !== 0) return
    const node = nodes.get(cardId)
    if (!node) return
    event.stopPropagation()
    dragRef.current = { kind: 'node', cardId, x: event.clientX, y: event.clientY, viewport, node: { x: node.x, y: node.y } }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  const zoom = (factor: number) => setViewport((current) => ({ ...current, scale: Math.max(0.28, Math.min(1.7, current.scale * factor)) }))
  const focusCard = (cardId: string) => {
    const node = nodes.get(cardId)
    const canvas = canvasRef.current
    if (!node || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const scale = Math.max(viewport.scale, 0.8)
    setSelected(cardId)
    setViewport({ scale, x: rect.width / 2 - (node.x + nodeWidth / 2) * scale, y: rect.height / 2 - (node.y + collapsedHeight / 2) * scale })
  }
  const searchMatch = search.trim().toLocaleLowerCase()
  const matches = searchMatch ? [...cards.values()].filter((card) => `${card.front} ${card.back}`.toLocaleLowerCase().includes(searchMatch)).slice(0, 6) : []
  return <main className="study-web-view">
    <header className="study-web-header"><button className="back-button" onClick={onBack}><ChevronLeft size={18} /> Study Web</button><div><p className="eyebrow">{set.title}</p><h1>{web.name}</h1></div>{web.outOfDate && <span className="study-web-stale">Study Web out of date</span>}<div className="study-web-header-actions">{aiEnabled && <button className="button button-quiet button-small ai-action" onClick={() => setConfirmRegenerate(true)}><Sparkles size={15} /> Regenerate Web</button>}</div></header>
    <section className="study-web-canvas" ref={canvasRef} onPointerDown={startCanvasDrag}>
      <div className="study-web-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a concept" />{search && <button onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>}{matches.length > 0 && <div>{matches.map((card) => <button key={card.id} onClick={() => { focusCard(card.id); setSearch('') }}><strong>{card.front}</strong><span>{card.back}</span></button>)}</div>}</div>
      <div className="study-web-controls"><button className="study-web-control" onClick={() => zoom(1.16)} aria-label="Zoom in"><Plus size={16} /></button><button className="study-web-control" onClick={() => zoom(.86)} aria-label="Zoom out"><Minus size={16} /></button><button className="study-web-control" onClick={fit} aria-label="Fit Study Web"><Maximize2 size={15} /></button><button className="study-web-control" onClick={() => setViewport({ x: 80, y: 80, scale: .8 })} aria-label="Reset view"><RotateCcw size={15} /></button></div>
      <div className="study-web-world" style={{ width: bounds.width, height: bounds.height, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`, transformOrigin: '0 0' }}>
        <svg className="study-web-edges" width={bounds.width} height={bounds.height} aria-hidden="true">{web.relationships.map((edge) => { const from = nodes.get(edge.sourceCardId); const to = nodes.get(edge.targetCardId); if (!from || !to) return null; const active = selected === edge.sourceCardId || selected === edge.targetCardId; return <line key={edge.id} x1={from.x + nodeWidth / 2 - bounds.minX} y1={from.y + collapsedHeight / 2 - bounds.minY} x2={to.x + nodeWidth / 2 - bounds.minX} y2={to.y + collapsedHeight / 2 - bounds.minY} className={active ? 'active' : selected ? 'muted' : ''} /> })}</svg>
        {web.groups.map((group) => { const groupNodes = group.cardIds.map((id) => nodes.get(id)).filter(Boolean); if (!groupNodes.length) return null; const x = Math.min(...groupNodes.map((node) => node!.x)) - bounds.minX; const y = Math.min(...groupNodes.map((node) => node!.y)) - bounds.minY - 34; return <span className="study-web-group-label" style={{ left: x, top: y }} key={group.id}>{group.label}</span> })}
        {[...nodes.values()].map((node) => { const card = cards.get(node.cardId); if (!card) return null; const isExpanded = expanded === card.id; const muted = selected && selected !== card.id && !related.has(card.id); return <button key={card.id} className={`study-web-node${isExpanded ? ' expanded' : ''}${selected === card.id ? ' selected' : ''}${muted ? ' muted' : ''}`} style={{ left: node.x - bounds.minX, top: node.y - bounds.minY }} onPointerDown={(event) => startNodeDrag(event, card.id)} onClick={(event) => { event.stopPropagation(); setSelected(card.id); setExpanded((current) => current === card.id ? null : card.id) }}><small>{set.progress.find((item) => item.cardId === card.id)?.mastery ?? 'new'}</small><strong>{card.front || 'Untitled card'}</strong>{isExpanded && <span className="study-web-definition">{card.back || 'No definition yet.'}<em onClick={(event) => { event.stopPropagation(); onStudyCard(card.id) }}>Study this concept</em></span>}</button> })}
      </div>
    </section>
    {confirmRegenerate && <div className="paper-dialog-backdrop"><section className="paper-dialog study-web-confirm"><header><h2>Regenerate Study Web?</h2><button className="icon-button" onClick={() => setConfirmRegenerate(false)}><X size={17} /></button></header><div className="paper-dialog-content"><p>SoFlo will re-analyze this set and replace the current organization and node positions.</p></div><footer><button className="button button-quiet" onClick={() => setConfirmRegenerate(false)}>Cancel</button><button className="button button-primary ai-action" onClick={() => { setConfirmRegenerate(false); onRegenerate() }}>Regenerate</button></footer></section></div>}
  </main>
}
