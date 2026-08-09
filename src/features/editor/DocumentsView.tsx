import { Bot, FilePlus2, FileUp, MoreHorizontal, Pin, Search, Trash2, Copy, X, GripVertical } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
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
}

export function DocumentsView({ documents, folders, aiEnabled, onOpen, onCreate, onImportPdf, onTrash, onDuplicate, onBulkRename, onGroup, onUngroup }: DocumentsViewProps) {
  const [query, setQuery] = useState('')
  const [aiOpen, setAiOpen] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<DocumentSummary | null>(null)
  const [bulkRename, setBulkRename] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return search ? documents.filter((paper) => `${paper.title} ${paper.excerpt}`.toLocaleLowerCase().includes(search)) : documents
  }, [documents, query])
  const grouped = useMemo(() => folders.map((folder) => ({ folder, papers: visible.filter((paper) => paper.folderId === folder.id) })).filter((group) => group.papers.length), [folders, visible])
  const loose = visible.filter((paper) => !paper.folderId)
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const paperId = String(active.id).replace('paper:', '')
    const target = String(over.id)
    if (target === 'paper-library-root') onUngroup(paperId)
    if (target.startsWith('paper:')) onGroup(paperId, target.replace('paper:', ''))
  }
  return <section className="documents-view">
    <div className="section-heading"><div><h2>Papers</h2><p>{documents.length ? `${documents.length} ${documents.length === 1 ? 'paper' : 'papers'} in this class` : 'Keep your work clear and connected.'}</p></div><div className="section-actions"><button className={`button button-quiet button-small${aiEnabled ? ' ai-action' : ''}`} onClick={onImportPdf}><FileUp size={15} /> Import document</button><button className="button button-primary button-small" onClick={onCreate}><FilePlus2 size={15} /> New paper</button></div></div>
    {documents.length ? <>
      <div className="paper-library-tools"><label className="paper-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search papers" aria-label="Search papers" /><button type="button" aria-label="Clear paper search" onClick={() => setQuery('')} className={query ? '' : 'invisible'}><X size={14} /></button></label>{aiEnabled && <div className="paper-ai"><button className="button button-quiet button-small ai-action" onClick={() => setAiOpen((current) => !current)}><Bot size={15} /> AI</button>{aiOpen && <div className="paper-action-menu ai-menu"><button onClick={() => { setAiOpen(false); setBulkRename(true) }}>Bulk rename papers</button></div>}</div>}</div>
      {visible.length ? <DndContext sensors={sensors} onDragEnd={onDragEnd}><PaperDropArea><div className="document-list">{grouped.map(({ folder, papers }) => <section className="paper-folder" key={folder.id}><header><span>{folder.title}</span><small>{papers.length} papers</small></header>{papers.map((document) => <PaperRow key={document.id} document={document} menuId={menuId} setMenuId={setMenuId} onOpen={onOpen} onTrash={onTrash} onDuplicate={setDuplicate} />)}</section>)}{loose.map((document) => <PaperRow key={document.id} document={document} menuId={menuId} setMenuId={setMenuId} onOpen={onOpen} onTrash={onTrash} onDuplicate={setDuplicate} />)}</div></PaperDropArea></DndContext> : <div className="quiet-empty"><Search size={18} /><p>No papers match “{query}”.</p></div>}
    </> : <div className="section-blank"><FilePlus2 size={27} /><h2>Your papers begin here.</h2><p>Use rich text, checklists, tables, code, and more—without worrying about saving.</p><div className="empty-note-actions"><button className="button button-primary" onClick={onCreate}><FilePlus2 size={16} /> Create your first paper</button><button className="button button-quiet" onClick={onImportPdf}><FileUp size={16} /> Import document</button></div></div>}
    {duplicate && <DuplicateDialog document={duplicate} onClose={() => setDuplicate(null)} onConfirm={(title) => { onDuplicate(duplicate, title); setDuplicate(null) }} />}
    {bulkRename && <BulkRenameDialog papers={visible} onClose={() => setBulkRename(false)} onConfirm={(papers) => { onBulkRename(papers); setBulkRename(false) }} />}
  </section>
}

function PaperDropArea({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'paper-library-root' })
  return <div ref={setNodeRef} className={`paper-drop-area${isOver ? ' paper-drop-target' : ''}`}>{children}</div>
}

function PaperRow({ document, menuId, setMenuId, onOpen, onTrash, onDuplicate }: { document: DocumentSummary; menuId: string | null; setMenuId: (id: string | null | ((current: string | null) => string | null)) => void; onOpen: (paper: DocumentSummary) => void; onTrash: (paper: DocumentSummary) => void; onDuplicate: (paper: DocumentSummary) => void }) {
  const { attributes, listeners, setNodeRef: setDraggableRef, transform, isDragging } = useDraggable({ id: `paper:${document.id}` })
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({ id: `paper:${document.id}` })
  const setNodeRef = (node: HTMLElement | null) => { setDraggableRef(node); setDroppableRef(node) }
  return <article ref={setNodeRef} style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined }} className={`document-row${isDragging ? ' paper-dragging' : ''}${isOver ? ' paper-drop-target' : ''}${menuId === document.id ? ' menu-open' : ''}`}><span className="paper-drag-handle" aria-label="Drag to group papers" {...attributes} {...listeners}><GripVertical size={16} /></span><button className="document-row-main" onClick={() => onOpen(document)}><span className="document-row-icon"><FilePlus2 size={18} /></span><span className="document-row-content"><strong>{document.title || 'Untitled paper'}</strong><small>{document.excerpt || 'Empty paper'} · Edited {formatDate(document.updatedAt)}</small></span>{document.isFavorite && <Pin className="pin-icon" size={15} />}</button><div className="paper-row-actions"><button className="icon-button tiny" aria-label={`Paper settings for ${document.title}`} onClick={() => setMenuId((current) => current === document.id ? null : document.id)}><MoreHorizontal size={17} /></button>{menuId === document.id && <div className="paper-action-menu"><button onClick={() => { setMenuId(null); onDuplicate(document) }}><Copy size={14} /> Duplicate</button><button className="danger" onClick={() => { setMenuId(null); onTrash(document) }}><Trash2 size={14} /> Move to trash</button></div>}</div></article>
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
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
