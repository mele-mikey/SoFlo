import { ChevronLeft, Maximize2, Minus, Pencil, Pin, PinOff, Plus, RotateCcw, Search, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import type { FlashcardSetDetail, StudyWebDetail, StudyWebNode } from '../../lib/types'

type Viewport = { x: number; y: number; scale: number }

interface StudyWebViewProps { web: StudyWebDetail; sets: FlashcardSetDetail[]; aiEnabled: boolean; onBack: () => void; onRegenerate: () => void; onStudyCard: (cardId: string) => void }

const nodeWidth = 244
const collapsedHeight = 68

function openCardHeight(card: { front: string; back: string } | undefined) {
  if (!card) return 150
  const titleLines = Math.max(1, Math.ceil((card.front || 'Untitled card').length / 23))
  const definitionLines = Math.max(1, Math.ceil((card.back || 'No definition yet.').length / 34))
  return 106 + titleLines * 19 + definitionLines * 18
}

function resolveNodeOverlap(nodes: StudyWebNode[], expanded: string | null, cards: Map<string, { front: string; back: string }>) {
  const placed: Array<{ node: StudyWebNode; x: number; y: number; height: number }> = []
  for (const node of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const height = node.pinned || expanded === node.cardId ? openCardHeight(cards.get(node.cardId)) : collapsedHeight
    let x = node.x
    let y = node.y
    for (let pass = 0; pass < 64; pass += 1) {
      const collision = placed.find((other) => x < other.x + nodeWidth + 24 && x + nodeWidth + 24 > other.x && y < other.y + other.height + 24 && y + height + 24 > other.y)
      if (!collision) break
      y = collision.y + collision.height + 28
    }
    placed.push({ node, x, y, height })
  }
  return placed
}

export function StudyWebView({ web, sets, aiEnabled, onBack, onRegenerate, onStudyCard }: StudyWebViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 80, scale: 0.8 })
  const [nodes, setNodes] = useState(() => new Map(web.nodes.map((node) => [node.cardId, node])))
  const nodesRef = useRef(nodes)
  const [relationships, setRelationships] = useState(web.relationships)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editingLinks, setEditingLinks] = useState(false)
  const [linkSource, setLinkSource] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const dragRef = useRef<{ kind: 'canvas' | 'node'; cardId?: string; x: number; y: number; viewport: Viewport; node?: { x: number; y: number }; moved: boolean } | null>(null)
  const consumeNodeClick = useRef<string | null>(null)
  const cards = useMemo(() => new Map(sets.flatMap((set) => set.cards).map((card) => [card.id, card])), [sets])
  const sourceLabel = sets.length === 1 ? sets[0]?.title : `${sets.length} flashcard sets`
  const related = useMemo(() => selected ? new Set(relationships.flatMap((edge) => edge.sourceCardId === selected ? [edge.targetCardId] : edge.targetCardId === selected ? [edge.sourceCardId] : [])) : new Set<string>(), [relationships, selected])
  const visualRelationships = useMemo(() => relationships.length ? relationships : web.groups.flatMap((group) => group.cardIds.slice(1).map((cardId, index) => ({ id: `group-${group.id}-${index}`, sourceCardId: group.cardIds[index], targetCardId: cardId, relationshipType: 'related_to', strength: .42 }))), [relationships, web.groups])
  const laidOutNodes = useMemo(() => resolveNodeOverlap([...nodes.values()], expanded, cards), [cards, nodes, expanded])
  const displayNodes = useMemo(() => new Map(laidOutNodes.map((item) => [item.node.cardId, item])), [laidOutNodes])
  const allPinned = nodes.size > 0 && [...nodes.values()].every((node) => node.pinned)
  const bounds = useMemo(() => {
    if (!laidOutNodes.length) return { minX: 0, minY: 0, width: 1000, height: 760 }
    const minX = Math.min(...laidOutNodes.map((item) => item.x)) - 180
    const minY = Math.min(...laidOutNodes.map((item) => item.y)) - 140
    const maxX = Math.max(...laidOutNodes.map((item) => item.x + nodeWidth)) + 220
    const maxY = Math.max(...laidOutNodes.map((item) => item.y + item.height)) + 200
    return { minX, minY, width: Math.max(900, maxX - minX), height: Math.max(700, maxY - minY) }
  }, [laidOutNodes])
  const fit = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const scale = Math.max(.34, Math.min(1, Math.min((rect.width - 96) / bounds.width, (rect.height - 96) / bounds.height)))
    setViewport({ scale, x: (rect.width - bounds.width * scale) / 2 - bounds.minX * scale, y: (rect.height - bounds.height * scale) / 2 - bounds.minY * scale })
  }
  useEffect(() => { const frame = requestAnimationFrame(fit); return () => cancelAnimationFrame(frame) }, [web.id])
  useEffect(() => { const next = new Map(web.nodes.map((node) => [node.cardId, node])); nodesRef.current = next; setNodes(next); setRelationships(web.relationships); setExpanded(null); setSelected(null); setLinkSource(null) }, [web.nodes, web.relationships])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        const factor = event.deltaY < 0 ? 1.1 : .9
        setViewport((current) => { const scale = Math.max(.28, Math.min(1.7, current.scale * factor)); const x = event.clientX - rect.left; const y = event.clientY - rect.top; return { scale, x: x - (x - current.x) * (scale / current.scale), y: y - (y - current.y) * (scale / current.scale) } })
      } else setViewport((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
    }
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => canvas.removeEventListener('wheel', wheel)
  }, [])
  const move = (event: PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const deltaX = event.clientX - drag.x
    const deltaY = event.clientY - drag.y
    if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) drag.moved = true
    if (drag.kind === 'canvas') setViewport({ ...drag.viewport, x: drag.viewport.x + deltaX, y: drag.viewport.y + deltaY })
    if (drag.kind === 'node' && drag.cardId && drag.node) {
      const x = drag.node.x + deltaX / drag.viewport.scale
      const y = drag.node.y + deltaY / drag.viewport.scale
      setNodes((current) => { const next = new Map(current); const node = next.get(drag.cardId!); if (node) next.set(drag.cardId!, { ...node, x, y, manuallyPositioned: true }); nodesRef.current = next; return next })
    }
  }
  const stop = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.kind === 'node' && drag.cardId) { if (drag.moved) consumeNodeClick.current = drag.cardId; const node = nodesRef.current.get(drag.cardId); if (node) void api.saveStudyWebNodePosition({ studyWebId: web.id, cardId: node.cardId, x: node.x, y: node.y }) }
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
  }
  const startCanvasDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return
    if ((event.target as HTMLElement).closest('.study-web-node, .study-web-control, .study-web-search')) return
    if (event.button === 0) { setSelected(null); setExpanded(null); if (editingLinks) setLinkSource(null) }
    event.preventDefault(); dragRef.current = { kind: 'canvas', x: event.clientX, y: event.clientY, viewport, moved: false }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop)
  }
  const startNodeDrag = (event: React.PointerEvent<HTMLButtonElement>, cardId: string) => {
    if (event.button !== 0 || editingLinks) return
    const node = nodes.get(cardId); if (!node) return
    event.stopPropagation(); dragRef.current = { kind: 'node', cardId, x: event.clientX, y: event.clientY, viewport, node: { x: node.x, y: node.y }, moved: false }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop)
  }
  const setPinned = (cardId: string, pinned: boolean) => {
    const node = nodesRef.current.get(cardId); if (!node) return
    const next = new Map(nodesRef.current); next.set(cardId, { ...node, pinned }); nodesRef.current = next; setNodes(next)
    void api.saveStudyWebNodePosition({ studyWebId: web.id, cardId, x: node.x, y: node.y, pinned })
  }
  const setAllPinned = (pinned: boolean) => {
    const next = new Map([...nodesRef.current].map(([id, node]) => [id, { ...node, pinned }])); nodesRef.current = next; setNodes(next)
    void Promise.all([...next.values()].map((node) => api.saveStudyWebNodePosition({ studyWebId: web.id, cardId: node.cardId, x: node.x, y: node.y, pinned })))
  }
  const toggleLink = async (sourceCardId: string, targetCardId: string) => {
    try {
      const result = await api.toggleStudyWebRelationship({ studyWebId: web.id, sourceCardId, targetCardId })
      setRelationships((current) => {
        const without = current.filter((edge) => !((edge.sourceCardId === sourceCardId && edge.targetCardId === targetCardId) || (edge.sourceCardId === targetCardId && edge.targetCardId === sourceCardId)))
        return result ? [...without, result] : without
      })
    } catch { /* The canvas stays usable if a stale node was removed elsewhere. */ }
  }
  const clickNode = (cardId: string, pinned: boolean) => {
    if (consumeNodeClick.current === cardId) { consumeNodeClick.current = null; return }
    if (editingLinks) {
      if (!linkSource || linkSource === cardId) { setLinkSource(linkSource === cardId ? null : cardId); setSelected(linkSource === cardId ? null : cardId); return }
      void toggleLink(linkSource, cardId); setSelected(linkSource); return
    }
    setSelected(cardId); if (!pinned) setExpanded((current) => current === cardId ? null : cardId)
  }
  const zoom = (factor: number) => setViewport((current) => ({ ...current, scale: Math.max(.28, Math.min(1.7, current.scale * factor)) }))
  const focusCard = (cardId: string) => { const node = displayNodes.get(cardId); const canvas = canvasRef.current; if (!node || !canvas) return; const rect = canvas.getBoundingClientRect(); const scale = Math.max(viewport.scale, .8); setSelected(cardId); setExpanded(cardId); setViewport({ scale, x: rect.width / 2 - (node.x + nodeWidth / 2) * scale, y: rect.height / 2 - (node.y + collapsedHeight / 2) * scale }) }
  const searchMatch = search.trim().toLocaleLowerCase()
  const matches = searchMatch ? [...cards.values()].filter((card) => `${card.front} ${card.back}`.toLocaleLowerCase().includes(searchMatch)).slice(0, 6) : []
  return <main className="study-web-view">
    <header className="study-web-header"><button className="back-button" onClick={onBack}><ChevronLeft size={18} /> Study Web</button><div><p className="eyebrow">{sourceLabel}</p><h1>{web.name}</h1></div>{web.outOfDate && <span className="study-web-stale">Study Web out of date</span>}<div className="study-web-header-actions"><button className={`button button-quiet button-small${editingLinks ? ' active' : ''}`} onClick={() => { setEditingLinks((current) => !current); setLinkSource(null); setSelected(null) }}><Pencil size={15} /> {editingLinks ? 'Done editing' : 'Edit links'}</button><button className={`button button-quiet button-small${allPinned ? ' active' : ''}`} onClick={() => setAllPinned(!allPinned)} title={allPinned ? 'Unpin all cards' : 'Pin all cards'}>{allPinned ? <PinOff size={15} /> : <Pin size={15} />}{allPinned ? ' Unpin all' : ' Pin all'}</button>{aiEnabled && <button className="button button-quiet button-small ai-action" onClick={() => setConfirmRegenerate(true)}><Sparkles size={15} /> Regenerate Web</button>}</div></header>
    <section className={`study-web-canvas${editingLinks ? ' editing-links' : ''}`} ref={canvasRef} onPointerDown={startCanvasDrag}>
      {editingLinks && <div className="study-web-edit-hint">{linkSource ? 'Click another card to add or remove its link.' : 'Select a card, then choose another to link or unlink.'}</div>}
      <div className="study-web-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a concept" />{search && <button onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>}{matches.length > 0 && <div>{matches.map((card) => <button key={card.id} onClick={() => { focusCard(card.id); setSearch('') }}><strong>{card.front}</strong><span>{card.back}</span></button>)}</div>}</div>
      <div className="study-web-controls"><button className="study-web-control" onClick={() => zoom(1.16)} aria-label="Zoom in"><Plus size={16} /></button><button className="study-web-control" onClick={() => zoom(.86)} aria-label="Zoom out"><Minus size={16} /></button><button className="study-web-control" onClick={fit} aria-label="Fit Study Web"><Maximize2 size={15} /></button><button className="study-web-control" onClick={() => setViewport({ x: 80, y: 80, scale: .8 })} aria-label="Reset view"><RotateCcw size={15} /></button></div>
      <div className="study-web-world" style={{ width: bounds.width, height: bounds.height, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`, transformOrigin: '0 0' }}>
        <svg className="study-web-edges" width={bounds.width} height={bounds.height} aria-hidden="true">{visualRelationships.map((edge) => { const from = displayNodes.get(edge.sourceCardId); const to = displayNodes.get(edge.targetCardId); if (!from || !to) return null; const active = selected === edge.sourceCardId || selected === edge.targetCardId; return <line key={edge.id} x1={from.x + nodeWidth / 2 - bounds.minX} y1={from.y + collapsedHeight / 2 - bounds.minY} x2={to.x + nodeWidth / 2 - bounds.minX} y2={to.y + collapsedHeight / 2 - bounds.minY} className={active ? 'active' : selected ? 'muted' : ''} /> })}</svg>
        {web.groups.map((group) => { const groupNodes = group.cardIds.map((id) => displayNodes.get(id)).filter(Boolean); if (!groupNodes.length) return null; const x = Math.min(...groupNodes.map((node) => node!.x)) - bounds.minX; const y = Math.min(...groupNodes.map((node) => node!.y)) - bounds.minY - 34; return <span className="study-web-group-label" style={{ left: x, top: y }} key={group.id}>{group.label}</span> })}
        {laidOutNodes.map(({ node, x, y }) => { const card = cards.get(node.cardId); if (!card) return null; const isExpanded = node.pinned || expanded === card.id; const muted = !editingLinks && selected && selected !== card.id && !related.has(card.id); return <button key={card.id} className={`study-web-node${isExpanded ? ' expanded' : ''}${node.pinned ? ' pinned' : ''}${linkSource === card.id ? ' link-source' : ''}${selected === card.id ? ' selected' : ''}${muted ? ' muted' : ''}`} style={{ left: x - bounds.minX, top: y - bounds.minY }} onPointerDown={(event) => startNodeDrag(event, card.id)} onClick={(event) => { event.stopPropagation(); clickNode(card.id, node.pinned) }}><span className="study-web-card-pin" role="button" tabIndex={0} title={node.pinned ? 'Unpin card' : 'Keep card open'} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setPinned(card.id, !node.pinned) }}>{node.pinned ? <PinOff size={13} /> : <Pin size={13} />}</span><strong>{card.front || 'Untitled card'}</strong>{isExpanded && <span className="study-web-definition">{card.back || 'No definition yet.'}<em onClick={(event) => { event.stopPropagation(); onStudyCard(card.id) }}>Study this concept</em></span>}</button> })}
      </div>
    </section>
    {confirmRegenerate && <div className="paper-dialog-backdrop"><section className="paper-dialog study-web-confirm"><header><h2>Regenerate Study Web?</h2><button className="icon-button" onClick={() => setConfirmRegenerate(false)}><X size={17} /></button></header><div className="paper-dialog-content"><p>SoFlo will re-analyze this set and replace the current organization and node positions.</p></div><footer><button className="button button-quiet" onClick={() => setConfirmRegenerate(false)}>Cancel</button><button className="button button-primary ai-action" onClick={() => { setConfirmRegenerate(false); onRegenerate() }}>Regenerate</button></footer></section></div>}
  </main>
}
