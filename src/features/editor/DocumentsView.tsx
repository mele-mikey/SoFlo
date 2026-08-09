import { ChevronDown, Copy, FilePlus2, FileUp, GripVertical, ListFilter, MoreHorizontal, Pencil, Pin, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import type { DocumentFolder, DocumentSummary } from '../../lib/types'
import { formatDate } from '../../lib/format'

interface DocumentsViewProps {
  documents: DocumentSummary[]
  folders: DocumentFolder[]
  aiEnabled: boolean
  onOpen: (document: DocumentSummary) => void
  onCreate: () => void
  onImportPdf: () => void
  onTrash: (document: DocumentSummary) => void
  onDuplicate: (document: DocumentSummary, title: string) => void
  onBulkRename: (papers: { id: string; title: string }[]) => void
  onGroup: (id: string, targetId: string) => void
  onUngroup: (id: string) => void
  onRenameFolder: (id: string, title: string) => void
}

export function DocumentsView({ documents, folders, aiEnabled, onOpen, onCreate, onImportPdf, onTrash, onDuplicate, onBulkRename, onGroup, onUngroup, onRenameFolder }: DocumentsViewProps) {
  const [query, setQuery] = useState('')
  const [toolsOpen, setToolsOpen] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<DocumentSummary | null>(null)
  const [bulkRename, setBulkRename] = useState(false)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return search ? documents.filter((paper) => `${paper.title} ${paper.excerpt}`.toLocaleLowerCase().includes(search)) : documents
  }, [documents, query])
  const grouped = useMemo(() => folders.map((folder) => ({ folder, papers: visible.filter((paper) => paper.folderId === folder.id) })).filter((group) => group.papers.length), [folders, visible])
  const loose = visible.filter((paper) => !paper.folderId)
  const activeDragDocument = activeDragId ? documents.find((document) => document.id === activeDragId) ?? null : null
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveDragId(null)
    if (!over || active.id === over.id) return
    const paperId = String(active.id).replace('paper:', '')
    const target = String(over.id)
    if (target === 'paper-library-root') onUngroup(paperId)
    else if (target.startsWith('paper:')) onGroup(paperId, target.replace('paper:', ''))
  }
  const toggleFolder = (folderId: string) => setCollapsedFolders((current) => {
    const next = new Set(current)
    if (next.has(folderId)) next.delete(folderId)
    else next.add(folderId)
    return next
  })

  return <section className="documents-view">
    <div className="section-heading"><div><h2>Papers</h2><p>{documents.length ? `${documents.length} ${documents.length === 1 ? 'paper' : 'papers'} in this class` : 'Keep your work clear and connected.'}</p></div>{documents.length > 0 && <div className="section-actions"><button className={`button button-quiet button-small${aiEnabled ? ' ai-action' : ''}`} onClick={onImportPdf}><FileUp size={15} /> Import document</button><button className="button button-primary button-small" onClick={onCreate}><FilePlus2 size={15} /> New paper</button></div>}</div>
    {documents.length ? <>
      <div className="paper-library-tools"><label className="paper-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search papers" aria-label="Search papers" /><button type="button" aria-label="Clear paper search" onClick={() => setQuery('')} className={query ? '' : 'invisible'}><X size={14} /></button></label><div className="paper-filter"><button className="button button-quiet button-small" onClick={() => setToolsOpen((current) => !current)} aria-label="Paper filters and tools"><ListFilter size={15} /></button>{toolsOpen && <div className="paper-action-menu ai-menu"><button onClick={() => { setToolsOpen(false); setBulkRename(true) }}>Bulk rename papers</button></div>}</div></div>
      {visible.length ? <DndContext sensors={sensors} onDragStart={({ active }) => setActiveDragId(String(active.id).replace('paper:', ''))} onDragCancel={() => setActiveDragId(null)} onDragEnd={handleDragEnd}><PaperDropArea><div className="document-list">{grouped.map(({ folder, papers }) => <PaperFolder key={folder.id} folder={folder} collapsed={collapsedFolders.has(folder.id)} onToggle={() => toggleFolder(folder.id)} onRename={onRenameFolder}>{papers.map((document) => <PaperRow key={document.id} document={document} menuId={menuId} setMenuId={setMenuId} onOpen={onOpen} onTrash={onTrash} onDuplicate={setDuplicate} />)}</PaperFolder>)}{loose.map((document) => <PaperRow key={document.id} document={document} menuId={menuId} setMenuId={setMenuId} onOpen={onOpen} onTrash={onTrash} onDuplicate={setDuplicate} />)}</div></PaperDropArea><DragOverlay dropAnimation={null}>{activeDragDocument && <PaperDragPreview document={activeDragDocument} />}</DragOverlay></DndContext> : <div className="quiet-empty"><Search size={18} /><p>No papers match “{query}”.</p></div>}
    </> : <div className="section-blank"><FilePlus2 size={27} /><h2>Your papers begin here.</h2><p>Use rich text, checklists, tables, code, and more—without worrying about saving.</p><div className="empty-note-actions"><button className="button button-primary" onClick={onCreate}><FilePlus2 size={16} /> Create your first paper</button><button className={`button button-quiet${aiEnabled ? ' ai-action' : ''}`} onClick={onImportPdf}><FileUp size={16} /> Import document</button></div></div>}
    {duplicate && <DuplicateDialog document={duplicate} onClose={() => setDuplicate(null)} onConfirm={(title) => { onDuplicate(duplicate, title); setDuplicate(null) }} />}
    {bulkRename && <BulkRenameDialog papers={visible} onClose={() => setBulkRename(false)} onConfirm={(papers) => { onBulkRename(papers); setBulkRename(false) }} />}
  </section>
}

function PaperDropArea({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'paper-library-root' })
  return <div ref={setNodeRef} className={`paper-drop-area${isOver ? ' paper-drop-target' : ''}`}>{children}</div>
}

function PaperFolder({ folder, collapsed, onToggle, onRename, children }: { folder: DocumentFolder; collapsed: boolean; onToggle: () => void; onRename: (id: string, title: string) => void; children: ReactNode }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(folder.title)
  useEffect(() => setTitle(folder.title), [folder.title])
  const save = () => {
    const next = title.trim() || folder.title
    setTitle(next)
    setEditing(false)
    if (next !== folder.title) onRename(folder.id, next)
  }
  return <section className={`paper-folder${collapsed ? ' collapsed' : ''}`}><header><div className="paper-folder-name">{editing ? <input autoFocus value={title} aria-label="Group name" onChange={(event) => setTitle(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); save() } if (event.key === 'Escape') { setTitle(folder.title); setEditing(false) } }} /> : <><span>{folder.title}</span><button type="button" className="paper-folder-rename" onClick={() => setEditing(true)} aria-label={`Rename ${folder.title}`}><Pencil size={12} /></button></>}</div><button type="button" className="paper-folder-toggle" onClick={onToggle} aria-expanded={!collapsed} aria-label={`${collapsed ? 'Show' : 'Hide'} ${folder.title}`}><ChevronDown size={16} /></button></header>{!collapsed && children}</section>
}

function PaperRow({ document, menuId, setMenuId, onOpen, onTrash, onDuplicate }: { document: DocumentSummary; menuId: string | null; setMenuId: (id: string | null | ((current: string | null) => string | null)) => void; onOpen: (paper: DocumentSummary) => void; onTrash: (paper: DocumentSummary) => void; onDuplicate: (paper: DocumentSummary) => void }) {
  const { attributes, listeners, setNodeRef: setDraggableRef, isDragging } = useDraggable({ id: `paper:${document.id}` })
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({ id: `paper:${document.id}` })
  const setNodeRef = (node: HTMLElement | null) => { setDraggableRef(node); setDroppableRef(node) }
  return <article ref={setNodeRef} className={`document-row${isDragging ? ' paper-dragging' : ''}${isOver && !isDragging ? ' paper-drop-target' : ''}${menuId === document.id ? ' menu-open' : ''}`}><span className="paper-drag-handle" aria-label="Drag to group papers" {...attributes} {...listeners}><GripVertical size={16} /></span><button className="document-row-main" onClick={() => onOpen(document)}><span className="document-row-icon"><FilePlus2 size={18} /></span><span className="document-row-content"><strong>{document.title || 'Untitled paper'}</strong><small>{document.excerpt || 'Empty paper'} · Edited {formatDate(document.updatedAt)}</small></span>{document.isFavorite && <Pin className="pin-icon" size={15} />}</button><div className="paper-row-actions"><button className="icon-button tiny" aria-label={`Paper settings for ${document.title}`} onClick={() => setMenuId((current) => current === document.id ? null : document.id)}><MoreHorizontal size={17} /></button>{menuId === document.id && <div className="paper-action-menu"><button onClick={() => { setMenuId(null); onDuplicate(document) }}><Copy size={14} /> Duplicate</button><button className="danger" onClick={() => { setMenuId(null); onTrash(document) }}><Trash2 size={14} /> Move to trash</button></div>}</div></article>
}

function PaperDragPreview({ document }: { document: DocumentSummary }) {
  return <article className="document-row paper-drag-preview"><span className="paper-drag-handle"><GripVertical size={16} /></span><div className="document-row-main"><span className="document-row-icon"><FilePlus2 size={18} /></span><span className="document-row-content"><strong>{document.title || 'Untitled paper'}</strong><small>{document.excerpt || 'Empty paper'}</small></span></div></article>
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="paper-dialog-backdrop" role="presentation" onMouseDown={onClose}><section className="paper-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header>{children}</section></div>
}

function DuplicateDialog({ document, onClose, onConfirm }: { document: DocumentSummary; onClose: () => void; onConfirm: (title: string) => void }) {
  const [title, setTitle] = useState(`${document.title || 'Untitled paper'} copy`)
  return <Dialog title="Duplicate paper" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); if (title.trim()) onConfirm(title.trim()) }}><div className="paper-dialog-content"><label>New paper name<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label></div><footer><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!title.trim()}>Duplicate</button></footer></form></Dialog>
}

function BulkRenameDialog({ papers, onClose, onConfirm }: { papers: DocumentSummary[]; onClose: () => void; onConfirm: (papers: { id: string; title: string }[]) => void }) {
  const [caseStyle, setCaseStyle] = useState<'keep' | 'lower' | 'upper'>('keep')
  const [prefix, setPrefix] = useState('')
  const [spaces, setSpaces] = useState<'keep' | '_' | '-'>('keep')
  const renamed = papers.map((paper) => {
    let title = paper.title || 'Untitled paper'
    if (caseStyle === 'lower') title = title.toLocaleLowerCase()
    if (caseStyle === 'upper') title = title.toLocaleUpperCase()
    if (spaces !== 'keep') title = title.replace(/\s+/g, spaces)
    return { id: paper.id, title: `${prefix}${title}` }
  })
  return <Dialog title="Bulk rename papers" onClose={onClose}><div className="paper-dialog-content"><p>Apply a reusable naming preset to the {papers.length} paper{papers.length === 1 ? '' : 's'} currently shown.</p><div className="rename-controls"><label>Letter case<select value={caseStyle} onChange={(event) => setCaseStyle(event.target.value as typeof caseStyle)}><option value="keep">Keep as typed</option><option value="lower">all lowercase</option><option value="upper">ALL UPPERCASE</option></select></label><label>Prefix<input value={prefix} placeholder="e.g. M_Mele_" onChange={(event) => setPrefix(event.target.value)} /></label><label>Spaces<select value={spaces} onChange={(event) => setSpaces(event.target.value as typeof spaces)}><option value="keep">Keep spaces</option><option value="_">Replace with _</option><option value="-">Replace with -</option></select></label></div><div className="rename-preview"><small>Preview</small>{renamed.slice(0, 4).map((paper) => <span key={paper.id}>{paper.title}</span>)}{renamed.length > 4 && <span>+ {renamed.length - 4} more</span>}</div></div><footer><button className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" onClick={() => onConfirm(renamed)} disabled={!renamed.length}>Rename papers</button></footer></Dialog>
}
