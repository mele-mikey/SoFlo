import { ChevronLeft, Layers3, Maximize2, Minus, Pencil, Pin, PinOff, Plus, RotateCcw, Search, Settings2, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { SOFLO_PRESET_COLORS } from '../../lib/colors'
import type { Flashcard, FlashcardSetDetail, StudyWebDetail, StudyWebGroup, StudyWebNode } from '../../lib/types'

type Viewport = { x: number; y: number; scale: number }

interface StudyWebViewProps { web: StudyWebDetail; sets: FlashcardSetDetail[]; aiEnabled: boolean; autoPin: boolean; groupHighlights: boolean; startInEditMode?: boolean; onBack: () => void; onRegenerate: () => void; onStudyCard: (cardId: string) => void; onSettingsChange: (settings: { studyWebAutoPin: boolean; studyWebGroupHighlights: boolean }) => Promise<void> }

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

function compactAutomaticNodes(nodes: StudyWebNode[]) {
  if (nodes.length < 2 || nodes.some((node) => node.manuallyPositioned)) return nodes
  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxX = Math.max(...nodes.map((node) => node.x))
  const maxY = Math.max(...nodes.map((node) => node.y))
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  const targetWidth = Math.max(880, Math.sqrt(nodes.length) * 390)
  const targetHeight = Math.max(680, Math.sqrt(nodes.length) * 315)
  const scale = Math.min(1, targetWidth / width, targetHeight / height)
  if (scale > .94) return nodes
  return nodes.map((node) => ({ ...node, x: minX + (node.x - minX) * scale, y: minY + (node.y - minY) * scale }))
}

function groupLabelPlacements(groups: StudyWebGroup[], nodes: Map<string, { x: number; y: number }>) {
  const childrenByParent = new Map<string, StudyWebGroup[]>()
  for (const group of groups) if (group.parentGroupId) childrenByParent.set(group.parentGroupId, [...(childrenByParent.get(group.parentGroupId) ?? []), group])
  return groups.flatMap((group) => {
    // The narrow label is the useful label on the canvas. Broad parent themes
    // organize the layout internally, but repeating them in the middle makes
    // the web harder to scan.
    if (childrenByParent.has(group.id)) return []
    const groupNodes = group.cardIds.map((id) => nodes.get(id)).filter((node): node is { x: number; y: number } => Boolean(node))
    if (!groupNodes.length) return []
    const minX = Math.min(...groupNodes.map((node) => node.x))
    const minY = Math.min(...groupNodes.map((node) => node.y))
    return [{ id: group.id, label: group.label, color: group.color, parent: false, x: minX, y: minY - 31 }]
  })
}

function groupHighlightPlacements(groups: StudyWebGroup[], nodes: Map<string, { x: number; y: number; height: number }>) {
  const childrenByParent = new Map<string, StudyWebGroup[]>()
  for (const group of groups) if (group.parentGroupId) childrenByParent.set(group.parentGroupId, [...(childrenByParent.get(group.parentGroupId) ?? []), group])
  return groups.flatMap((group) => {
    if (childrenByParent.has(group.id)) return []
    const members = group.cardIds.map((id) => nodes.get(id)).filter((node): node is { x: number; y: number; height: number } => Boolean(node))
    if (!members.length) return []
    const left = Math.min(...members.map((node) => node.x)) - 30
    const top = Math.min(...members.map((node) => node.y)) - 47
    const right = Math.max(...members.map((node) => node.x + nodeWidth)) + 30
    const bottom = Math.max(...members.map((node) => node.y + node.height)) + 30
    return [{ id: group.id, label: group.label, color: group.color, left, top, width: right - left, height: bottom - top }]
  })
}

type StudyWebCanvasEdge = { id: string; sourceCardId: string; targetCardId: string; structural: boolean }
type StudyWebDrag =
  | { kind: 'canvas'; x: number; y: number; viewport: Viewport; moved: boolean }
  | { kind: 'node'; cardId: string; x: number; y: number; viewport: Viewport; node: { x: number; y: number }; moved: boolean }
  | { kind: 'group'; groupId: string; x: number; y: number; viewport: Viewport; nodes: Map<string, { x: number; y: number }>; moved: boolean }

// The AI supplies a hierarchy, not invisible connector coordinates. Turn that
// hierarchy into a light card-to-card tree so every visible line starts and
// ends on an actual concept card.
function studyWebHierarchyEdges(groups: StudyWebGroup[]): StudyWebCanvasEdge[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const group of groups) {
    if (group.parentGroupId && byId.has(group.parentGroupId)) children.set(group.parentGroupId, [...(children.get(group.parentGroupId) ?? []), group.id])
    else roots.push(group.id)
  }
  const edges: StudyWebCanvasEdge[] = []
  const seen = new Set<string>()
  const add = (sourceCardId: string | null, targetCardId: string | null, id: string) => {
    if (!sourceCardId || !targetCardId || sourceCardId === targetCardId) return
    const key = [sourceCardId, targetCardId].sort().join(':')
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ id, sourceCardId, targetCardId, structural: true })
  }
  const anchor = (groupId: string): string | null => {
    const group = byId.get(groupId)
    if (!group) return null
    if (group.cardIds.length) return group.cardIds[0]
    for (const childId of children.get(groupId) ?? []) {
      const childAnchor = anchor(childId)
      if (childAnchor) return childAnchor
    }
    return null
  }
  for (const group of groups) {
    const ownAnchor = group.cardIds[0] ?? null
    const childAnchors = (children.get(group.id) ?? []).map(anchor).filter((cardId): cardId is string => Boolean(cardId))
    const groupAnchor = ownAnchor ?? childAnchors[0] ?? null
    for (const childAnchor of childAnchors) add(groupAnchor, childAnchor, `child:${group.id}:${childAnchor}`)
  }
  // Root themes are intentionally connected as a tree so the canvas remains
  // one navigable web even when two high-level themes do not share a card.
  const rootAnchors = roots.map(anchor).filter((cardId): cardId is string => Boolean(cardId))
  for (let index = 1; index < rootAnchors.length; index += 1) add(rootAnchors[index - 1], rootAnchors[index], `root:${index}`)
  return edges
}

export function StudyWebView({ web, sets, aiEnabled, autoPin, groupHighlights, startInEditMode = false, onBack, onRegenerate, onStudyCard, onSettingsChange }: StudyWebViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 80, scale: 0.8 })
  const [nodes, setNodes] = useState(() => new Map(compactAutomaticNodes(web.nodes).map((node) => [node.cardId, node])))
  const nodesRef = useRef(nodes)
  const [relationships, setRelationships] = useState(web.relationships)
  const [groups, setGroups] = useState(web.groups)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editingLinks, setEditingLinks] = useState(startInEditMode)
  const [groupEditMode, setGroupEditMode] = useState(false)
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [newGroupCardId, setNewGroupCardId] = useState<string | null>(null)
  const [newGroupLabel, setNewGroupLabel] = useState('')
  const [savingGroup, setSavingGroup] = useState(false)
  const [linkSource, setLinkSource] = useState<string | null>(null)
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [editingCardId, setEditingCardId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState({ autoPin, groupHighlights })
  const [savingSettings, setSavingSettings] = useState(false)
  const [multiSelectedCardIds, setMultiSelectedCardIds] = useState<Set<string>>(() => new Set())
  const [groupColorMenuId, setGroupColorMenuId] = useState<string | null>(null)
  const dragRef = useRef<StudyWebDrag | null>(null)
  const consumeNodeClick = useRef<string | null>(null)
  const consumeGroupClick = useRef<string | null>(null)
  const [cards, setCards] = useState(() => new Map<string, Flashcard>(sets.flatMap((set) => set.cards).map((card) => [card.id, card])))
  const hierarchyEdges = useMemo(() => studyWebHierarchyEdges(groups), [groups])
  const visualRelationships = useMemo<StudyWebCanvasEdge[]>(() => {
    const seen = new Set<string>()
    const combined: StudyWebCanvasEdge[] = []
    const add = (edge: StudyWebCanvasEdge) => {
      const key = [edge.sourceCardId, edge.targetCardId].sort().join(':')
      if (!seen.has(key)) { seen.add(key); combined.push(edge) }
    }
    for (const edge of relationships) {
      // Generated connections from earlier builds were used as hidden layout
      // anchors. Keep only the links a person explicitly made on the canvas.
      if (edge.relationshipType !== 'manual_related') continue
      add({ id: edge.id, sourceCardId: edge.sourceCardId, targetCardId: edge.targetCardId, structural: false })
    }
    for (const edge of hierarchyEdges) add(edge)
    return combined
  }, [hierarchyEdges, relationships])
  const related = useMemo(() => selected ? new Set(visualRelationships.flatMap((edge) => edge.sourceCardId === selected ? [edge.targetCardId] : edge.targetCardId === selected ? [edge.sourceCardId] : [])) : new Set<string>(), [selected, visualRelationships])
  const laidOutNodes = useMemo(() => resolveNodeOverlap([...nodes.values()], expanded, cards), [cards, nodes, expanded])
  const displayNodes = useMemo(() => new Map(laidOutNodes.map((item) => [item.node.cardId, item])), [laidOutNodes])
  const groupLabels = useMemo(() => groupLabelPlacements(groups, displayNodes), [displayNodes, groups])
  const groupHighlightRects = useMemo(() => groupHighlightPlacements(groups, displayNodes), [displayNodes, groups])
  const activeGroup = useMemo(() => groups.find((group) => group.id === activeGroupId) ?? null, [activeGroupId, groups])
  const activeGroupCards = useMemo(() => new Set(activeGroup?.cardIds ?? []), [activeGroup])
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
  useEffect(() => setCards(new Map(sets.flatMap((set) => set.cards).map((card) => [card.id, card]))), [sets])
  useEffect(() => { const next = new Map(compactAutomaticNodes(web.nodes).map((node) => [node.cardId, node])); nodesRef.current = next; setNodes(next); setRelationships(web.relationships); setGroups(web.groups); setExpanded(null); setSelected(null); setLinkSource(null); setMultiSelectedCardIds(new Set()); setGroupColorMenuId(null); setGroupEditMode(false); setActiveGroupId(null); setNewGroupCardId(null); setNewGroupLabel(''); setEditingLinks(startInEditMode) }, [startInEditMode, web.groups, web.nodes, web.relationships])
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
    if (drag.kind === 'group') {
      const offsetX = deltaX / drag.viewport.scale
      const offsetY = deltaY / drag.viewport.scale
      setNodes((current) => {
        const next = new Map(current)
        for (const [cardId, original] of drag.nodes) {
          const node = next.get(cardId)
          if (node) next.set(cardId, { ...node, x: original.x + offsetX, y: original.y + offsetY, manuallyPositioned: true })
        }
        nodesRef.current = next
        return next
      })
    }
  }
  const stop = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.kind === 'node' && drag.cardId) { if (drag.moved) consumeNodeClick.current = drag.cardId; const node = nodesRef.current.get(drag.cardId); if (node) void api.saveStudyWebNodePosition({ studyWebId: web.id, cardId: node.cardId, x: node.x, y: node.y }) }
    if (drag?.kind === 'group' && drag.moved) { consumeGroupClick.current = drag.groupId; void Promise.all([...drag.nodes.keys()].map((cardId) => { const node = nodesRef.current.get(cardId); return node ? api.saveStudyWebNodePosition({ studyWebId: web.id, cardId, x: node.x, y: node.y }) : Promise.resolve() })) }
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
  }
  const startCanvasDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return
    if ((event.target as HTMLElement).closest('.study-web-node, .study-web-control, .study-web-search, .study-web-edit-tools, .study-web-settings-menu')) return
    if (event.button === 0) { setSelected(null); setExpanded(null); setMultiSelectedCardIds(new Set()); setGroupColorMenuId(null); if (editingLinks) { setLinkSource(null); if (groupEditMode) setActiveGroupId(null) } }
    event.preventDefault(); dragRef.current = { kind: 'canvas', x: event.clientX, y: event.clientY, viewport, moved: false }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop)
  }
  const startNodeDrag = (event: React.PointerEvent<HTMLButtonElement>, cardId: string) => {
    if (event.button !== 0 || editingLinks) return
    const node = nodes.get(cardId); if (!node) return
    event.stopPropagation(); dragRef.current = { kind: 'node', cardId, x: event.clientX, y: event.clientY, viewport, node: { x: node.x, y: node.y }, moved: false }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop)
  }
  const startGroupDrag = (event: React.PointerEvent<HTMLButtonElement>, groupId: string) => {
    if (!groupEditMode || event.button !== 0) return
    const group = groups.find((item) => item.id === groupId)
    if (!group) return
    const groupNodes = new Map(group.cardIds.flatMap((cardId) => { const node = nodesRef.current.get(cardId); return node ? [[cardId, { x: node.x, y: node.y }] as const] : [] }))
    if (!groupNodes.size) return
    event.stopPropagation()
    dragRef.current = { kind: 'group', groupId, x: event.clientX, y: event.clientY, viewport, nodes: groupNodes, moved: false }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  const setPinned = (cardId: string, pinned: boolean) => {
    if (autoPin && !pinned) return
    const node = nodesRef.current.get(cardId); if (!node) return
    const next = new Map(nodesRef.current); next.set(cardId, { ...node, pinned }); nodesRef.current = next; setNodes(next)
    void api.saveStudyWebNodePosition({ studyWebId: web.id, cardId, x: node.x, y: node.y, pinned })
  }
  const setAllPinned = (pinned: boolean) => {
    if (autoPin && !pinned) return
    const next = new Map([...nodesRef.current].map(([id, node]) => [id, { ...node, pinned }])); nodesRef.current = next; setNodes(next)
    void Promise.all([...next.values()].map((node) => api.saveStudyWebNodePosition({ studyWebId: web.id, cardId: node.cardId, x: node.x, y: node.y, pinned })))
  }
  useEffect(() => {
    if (autoPin && [...nodes.values()].some((node) => !node.pinned)) setAllPinned(true)
  }, [autoPin, nodes, web.id])
  const createCard = async () => {
    const setId = web.flashcardSetIds[0]
    if (!setId) return
    const canvas = canvasRef.current?.getBoundingClientRect()
    const x = canvas ? (canvas.width / 2 - viewport.x) / viewport.scale - nodeWidth / 2 : 240
    const y = canvas ? (canvas.height / 2 - viewport.y) / viewport.scale - collapsedHeight / 2 : 220
    try {
      const card = await api.saveCard({ setId, front: 'Untitled concept', back: 'Add a definition for this concept.', position: cards.size, isStarred: false })
      await api.saveStudyWebNodePosition({ studyWebId: web.id, cardId: card.id, x, y, pinned: autoPin })
      if (groupEditMode && activeGroupId) {
        const detail = await api.updateStudyWebGroupMembership({ studyWebId: web.id, groupId: activeGroupId, cardId: card.id, included: true })
        setGroups(detail.groups)
      }
      setCards((current) => new Map(current).set(card.id, card))
      setNodes((current) => { const next = new Map(current); next.set(card.id, { cardId: card.id, x, y, manuallyPositioned: true, pinned: autoPin }); nodesRef.current = next; return next })
      setEditingCardId(card.id)
    } finally { setCreateMenuOpen(false) }
  }
  const saveCard = async (card: Flashcard) => {
    const saved = await api.saveCard({ id: card.id, setId: card.setId, front: card.front.trim() || 'Untitled concept', back: card.back.trim() || 'No definition yet.', notes: card.notes, imagePath: card.imagePath, position: card.position, isStarred: card.isStarred })
    setCards((current) => new Map(current).set(saved.id, saved))
    setEditingCardId(null)
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
  const editGroup = async (cardId: string) => {
    const selectedGroup = activeGroupId ? groups.find((group) => group.id === activeGroupId) ?? null : groups.find((group) => group.cardIds.includes(cardId)) ?? null
    if (!selectedGroup) {
      setSelected(cardId)
      setExpanded(null)
      setNewGroupLabel('')
      setNewGroupCardId(cardId)
      return
    }
    if (!activeGroupId) {
      setActiveGroupId(selectedGroup.id)
      setSelected(cardId)
      setExpanded(null)
      return
    }
    try {
      const detail = await api.updateStudyWebGroupMembership({
        studyWebId: web.id,
        groupId: selectedGroup.id,
        cardId,
        included: !selectedGroup.cardIds.includes(cardId),
      })
      setGroups(detail.groups)
      setActiveGroupId(detail.groups.some((group) => group.id === selectedGroup.id) ? selectedGroup.id : null)
      setSelected(selectedGroup.cardIds.includes(cardId) ? null : cardId)
    } catch { /* Keep the current group visible if a concurrent change wins. */ }
  }
  const createGroup = async (event: React.FormEvent) => {
    event.preventDefault()
    const cardId = newGroupCardId
    const label = newGroupLabel.trim()
    if (!cardId || !label) return
    setSavingGroup(true)
    try {
      const existingIds = new Set(groups.map((group) => group.id))
      const detail = await api.createStudyWebGroup({ studyWebId: web.id, cardId, label })
      const created = detail.groups.find((group) => !existingIds.has(group.id))
      setGroups(detail.groups)
      setActiveGroupId(created?.id ?? null)
      setSelected(cardId)
      setNewGroupCardId(null)
      setNewGroupLabel('')
    } finally { setSavingGroup(false) }
  }
  const clickNode = (cardId: string, pinned: boolean, additive = false) => {
    if (consumeNodeClick.current === cardId) { consumeNodeClick.current = null; return }
    if (editingLinks) {
      if (additive) {
        setMultiSelectedCardIds((current) => {
          const next = new Set(current)
          if (next.has(cardId)) next.delete(cardId)
          else if (next.size < 100) next.add(cardId)
          return next
        })
        return
      }
      setMultiSelectedCardIds(new Set())
      if (groupEditMode) { void editGroup(cardId); return }
      if (!linkSource || linkSource === cardId) { setLinkSource(linkSource === cardId ? null : cardId); setSelected(linkSource === cardId ? null : cardId); return }
      void toggleLink(linkSource, cardId); setSelected(linkSource); return
    }
    setSelected(cardId); if (!pinned) setExpanded((current) => current === cardId ? null : cardId)
  }
  const zoom = (factor: number) => setViewport((current) => ({ ...current, scale: Math.max(.28, Math.min(1.7, current.scale * factor)) }))
  const toggleEditMode = () => {
    setEditingLinks((current) => !current)
    setLinkSource(null)
    setSelected(null)
    setMultiSelectedCardIds(new Set())
    setGroupColorMenuId(null)
    setExpanded(null)
    setGroupEditMode(false)
    setActiveGroupId(null)
    setNewGroupCardId(null)
    setNewGroupLabel('')
    setCreateMenuOpen(false)
  }
  const toggleGroupEditMode = () => {
    setGroupEditMode((current) => !current)
    setLinkSource(null)
    setSelected(null)
    setMultiSelectedCardIds(new Set())
    setGroupColorMenuId(null)
    setActiveGroupId(null)
    setNewGroupCardId(null)
    setNewGroupLabel('')
    setCreateMenuOpen(false)
  }
  const openSettings = () => {
    setSettingsDraft({ autoPin, groupHighlights })
    setSettingsOpen((current) => !current)
  }
  const applySettings = async () => {
    setSavingSettings(true)
    try {
      await onSettingsChange({ studyWebAutoPin: settingsDraft.autoPin, studyWebGroupHighlights: settingsDraft.groupHighlights })
      setSettingsOpen(false)
    } finally { setSavingSettings(false) }
  }
  const setGroupColor = async (groupId: string, color: string) => {
    try {
      const detail = await api.updateStudyWebGroupColor({ studyWebId: web.id, groupId, color })
      setGroups(detail.groups)
    } finally { setGroupColorMenuId(null) }
  }
  const focusCard = (cardId: string) => { const node = displayNodes.get(cardId); const canvas = canvasRef.current; if (!node || !canvas) return; const rect = canvas.getBoundingClientRect(); const scale = Math.max(viewport.scale, .8); setSelected(cardId); setExpanded(cardId); setViewport({ scale, x: rect.width / 2 - (node.x + nodeWidth / 2) * scale, y: rect.height / 2 - (node.y + collapsedHeight / 2) * scale }) }
  const searchMatch = search.trim().toLocaleLowerCase()
  const matches = searchMatch ? [...cards.values()].filter((card) => `${card.front} ${card.back}`.toLocaleLowerCase().includes(searchMatch)).slice(0, 6) : []
  const edgePoint = (cardId: string) => {
    const node = displayNodes.get(cardId)
    if (!node) return null
    return { x: node.x + nodeWidth / 2, y: node.y + collapsedHeight / 2 }
  }
  return <main className="study-web-view">
    <header className="study-web-header"><button className="back-button" onClick={onBack}><ChevronLeft size={16} /> Back to Study Web</button>{web.outOfDate && <span className="study-web-stale">Study Web out of date</span>}<div className="study-web-header-actions"><button className={`button button-quiet button-small${allPinned ? ' active' : ''}`} disabled={autoPin} onClick={() => setAllPinned(!allPinned)} title={autoPin ? 'Auto pin is enabled in Study Web Settings.' : allPinned ? 'Unpin all cards' : 'Pin all cards'}>{autoPin || allPinned ? <Pin size={14} /> : <PinOff size={14} />}{autoPin ? ' Auto pin' : allPinned ? ' Unpin all' : ' Pin all'}</button>{aiEnabled && <button className="button button-quiet button-small ai-action" onClick={() => setConfirmRegenerate(true)}><Sparkles size={14} /> Regenerate Web</button>}</div></header>
    <section className={`study-web-canvas${editingLinks ? ' editing-links' : ''}`} ref={canvasRef} onPointerDown={startCanvasDrag}>
      {editingLinks && <div className="study-web-edit-hint">{groupEditMode ? activeGroup ? `Editing ${activeGroup.label}. Click cards to add or remove them.` : 'Click a card to select its concept group.' : linkSource ? 'Click another card to add or remove its link.' : 'Select a card, then choose another to link or unlink.'}</div>}
      <div className="study-web-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a concept" />{search && <button onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>}{matches.length > 0 && <div>{matches.map((card) => <button key={card.id} onClick={() => { focusCard(card.id); setSearch('') }}><strong>{card.front}</strong><span>{card.back}</span></button>)}</div>}</div>
      <div className={`study-web-edit-tools${editingLinks ? ' editing' : ''}`}><button className={`study-web-floating-control study-web-group-button${groupEditMode ? ' active' : ''}`} onClick={toggleGroupEditMode} aria-label={groupEditMode ? 'Return to link editing' : 'Edit concept group'} title={groupEditMode ? 'Return to link editing' : 'Edit group'}><Layers3 size={15} /></button><div className="study-web-add-control"><button className="study-web-add-button" onClick={() => setCreateMenuOpen((value) => !value)} aria-label="Create flashcard" title="Create flashcard"><Plus size={18} /></button>{createMenuOpen && <div className="study-web-add-menu"><button onClick={() => void createCard()}><Plus size={14} /> Create flashcard</button></div>}</div><button className={`study-web-floating-control study-web-edit-button${editingLinks ? ' active' : ''}`} onClick={toggleEditMode} aria-label={editingLinks ? 'Exit edit mode' : 'Enter edit mode'} title={editingLinks ? 'Exit edit mode' : 'Edit Study Web'}><Pencil size={18} /></button></div><div className="study-web-controls"><button className="study-web-control" onClick={() => zoom(1.16)} aria-label="Zoom in"><Plus size={16} /></button><button className="study-web-control" onClick={() => zoom(.86)} aria-label="Zoom out"><Minus size={16} /></button><button className="study-web-control" onClick={fit} aria-label="Fit Study Web"><Maximize2 size={15} /></button><button className="study-web-control" onClick={() => setViewport({ x: 80, y: 80, scale: .8 })} aria-label="Reset view"><RotateCcw size={15} /></button><div className="study-web-settings-menu"><button className={`study-web-control${settingsOpen ? ' active' : ''}`} onClick={openSettings} aria-label="Study Web options" title="Study Web options"><Settings2 size={15} /></button>{settingsOpen && <section className="study-web-settings-popover"><header><span>Study Web Settings</span></header><label><input type="checkbox" checked={settingsDraft.autoPin} onChange={(event) => setSettingsDraft((current) => ({ ...current, autoPin: event.target.checked }))} /><span><strong>Auto pin</strong><small>Automatically pins your Study Web cards.</small></span></label><label><input type="checkbox" checked={settingsDraft.groupHighlights} onChange={(event) => setSettingsDraft((current) => ({ ...current, groupHighlights: event.target.checked }))} /><span><strong>Group highlights</strong><small>Lightly tint concept groups on the canvas.</small></span></label><footer><button className="button button-quiet button-small" onClick={() => setSettingsOpen(false)}>Exit</button><button className="button button-primary button-small" disabled={savingSettings} onClick={() => void applySettings()}>{savingSettings ? 'Applying...' : 'Apply'}</button></footer></section>}</div></div>
      <div className="study-web-world" style={{ width: bounds.width, height: bounds.height, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`, transformOrigin: '0 0' }}>
        {(groupHighlights || groupEditMode) && groupHighlightRects.map((group) => <button type="button" className={`study-web-group-highlight${groupHighlights ? ' visible' : ''}${groupEditMode ? ' editable' : ''}${groupColorMenuId === group.id ? ' selected' : ''}`} style={{ left: group.left - bounds.minX, top: group.top - bounds.minY, width: group.width, height: group.height, '--study-web-group-color': group.color } as React.CSSProperties} key={group.id} aria-label={`Edit ${group.label} group`} onPointerDown={(event) => startGroupDrag(event, group.id)} onClick={(event) => { event.stopPropagation(); if (consumeGroupClick.current === group.id) { consumeGroupClick.current = null; return }; if (groupEditMode) setGroupColorMenuId((current) => current === group.id ? null : group.id) }} />)}
        <svg className="study-web-edges" width={bounds.width} height={bounds.height} aria-hidden="true">{visualRelationships.map((edge) => { const from = edgePoint(edge.sourceCardId); const to = edgePoint(edge.targetCardId); if (!from || !to) return null; const active = selected === edge.sourceCardId || selected === edge.targetCardId; return <line key={edge.id} x1={from.x - bounds.minX} y1={from.y - bounds.minY} x2={to.x - bounds.minX} y2={to.y - bounds.minY} className={`${edge.structural ? 'structure ' : ''}${active ? 'active' : selected ? 'muted' : ''}`} /> })}</svg>
        {groupLabels.map((group) => <span className={`study-web-group-label${group.parent ? ' parent' : ''}`} style={{ left: group.x - bounds.minX, top: group.y - bounds.minY, '--study-web-group-color': group.color } as React.CSSProperties} key={group.id}>{group.label}</span>)}
        {groupColorMenuId && groupHighlightRects.filter((group) => group.id === groupColorMenuId).map((group) => <section className="study-web-group-color-picker" style={{ left: group.left - bounds.minX + 12, top: group.top - bounds.minY + 12 }} key={group.id} onPointerDown={(event) => event.stopPropagation()}><span>Group color</span><div>{SOFLO_PRESET_COLORS.map((color) => <button key={color.value} type="button" className={color.value === group.color ? 'selected' : ''} style={{ background: color.value }} title={color.name} aria-label={`Use ${color.name}`} onClick={() => void setGroupColor(group.id, color.value)} />)}</div></section>)}
        {laidOutNodes.map(({ node, x, y }) => {
          const card = cards.get(node.cardId)
          if (!card) return null
          const isExpanded = node.pinned || expanded === card.id
          const muted = !editingLinks && selected && selected !== card.id && !related.has(card.id)
          return <button key={card.id} className={`study-web-node${isExpanded ? ' expanded' : ''}${node.pinned ? ' pinned' : ''}${linkSource === card.id ? ' link-source' : ''}${selected === card.id ? ' selected' : ''}${multiSelectedCardIds.has(card.id) ? ' multi-selected' : ''}${groupEditMode && activeGroupCards.has(card.id) ? ' group-member' : ''}${muted ? ' muted' : ''}`} style={{ left: x - bounds.minX, top: y - bounds.minY }} onPointerDown={(event) => startNodeDrag(event, card.id)} onClick={(event) => { event.stopPropagation(); clickNode(card.id, node.pinned, event.ctrlKey || event.metaKey) }}>
            <span className="study-web-card-pin" role="button" tabIndex={0} title={node.pinned ? 'Unpin card' : 'Keep card open'} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setPinned(card.id, !node.pinned) }}>{node.pinned ? <PinOff size={13} /> : <Pin size={13} />}</span>
            <span className="study-web-term"><strong>{card.front || 'Untitled card'}</strong>{editingLinks && <span className="study-web-inline-edit" role="button" tabIndex={0} title="Edit term" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditingCardId(card.id) }}><Pencil size={12} /></span>}</span>{isExpanded && <span className="study-web-definition"><span>{card.back || 'No definition yet.'}</span>{editingLinks && <span className="study-web-inline-edit definition" role="button" tabIndex={0} title="Edit definition" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditingCardId(card.id) }}><Pencil size={12} /></span>}{!web.isManual && <em onClick={(event) => { event.stopPropagation(); onStudyCard(card.id) }}>Study this concept</em>}</span>}
          </button>
        })}
      </div>
    </section>
    {editingCardId && cards.get(editingCardId) && <StudyWebCardEditor card={cards.get(editingCardId)!} onClose={() => setEditingCardId(null)} onSave={saveCard} />}
    {newGroupCardId && <div className="paper-dialog-backdrop"><section className="paper-dialog study-web-group-dialog" role="dialog" aria-modal="true" aria-label="Name Study Web group"><header><div><p className="eyebrow">STUDY WEB GROUP</p><h2>Name this group</h2></div><button className="icon-button" onClick={() => { setNewGroupCardId(null); setNewGroupLabel(''); setSelected(null) }} aria-label="Close"><X size={17} /></button></header><form onSubmit={(event) => void createGroup(event)}><div className="paper-dialog-content"><p>{cards.get(newGroupCardId)?.front || 'This card'} is not in a concept group yet. Give the new group a clear name.</p><label>Group name<input autoFocus value={newGroupLabel} onChange={(event) => setNewGroupLabel(event.target.value)} placeholder="e.g. Stomach and surrounding organs" maxLength={72} /></label></div><footer><button type="button" className="button button-quiet" onClick={() => { setNewGroupCardId(null); setNewGroupLabel(''); setSelected(null) }}>Cancel</button><button className="button button-primary" disabled={!newGroupLabel.trim() || savingGroup}>{savingGroup ? 'Creating...' : 'Create group'}</button></footer></form></section></div>}
    {confirmRegenerate && <div className="paper-dialog-backdrop"><section className="paper-dialog study-web-confirm"><header><h2>Regenerate Study Web?</h2><button className="icon-button" onClick={() => setConfirmRegenerate(false)}><X size={17} /></button></header><div className="paper-dialog-content"><p>SoFlo will re-analyze this set and replace the current organization and node positions.</p></div><footer><button className="button button-quiet" onClick={() => setConfirmRegenerate(false)}>Cancel</button><button className="button button-primary ai-action" onClick={() => { setConfirmRegenerate(false); onRegenerate() }}>Regenerate</button></footer></section></div>}
  </main>
}

function StudyWebCardEditor({ card, onClose, onSave }: { card: Flashcard; onClose: () => void; onSave: (card: Flashcard) => Promise<void> }) {
  const [front, setFront] = useState(card.front)
  const [back, setBack] = useState(card.back)
  const [saving, setSaving] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try { await onSave({ ...card, front, back }) } finally { setSaving(false) }
  }
  return <div className="paper-dialog-backdrop"><section className="paper-dialog study-web-card-editor" role="dialog" aria-modal="true" aria-label="Edit flashcard"><header><div><p className="eyebrow">STUDY WEB</p><h2>Edit flashcard</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header><form onSubmit={(event) => void submit(event)}><div className="paper-dialog-content"><label>Term<input autoFocus value={front} onChange={(event) => setFront(event.target.value)} /></label><label>Definition<textarea value={back} onChange={(event) => setBack(event.target.value)} /></label></div><footer><button className="button button-quiet" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!front.trim() || !back.trim() || saving}>{saving ? 'Saving...' : 'Save flashcard'}</button></footer></form></section></div>
}
