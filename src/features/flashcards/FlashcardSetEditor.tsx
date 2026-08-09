import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { BookOpen, ChevronLeft, ClipboardPaste, GripVertical, Plus, Sparkles, Star, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { Flashcard, FlashcardSetDetail } from '../../lib/types'

interface FlashcardSetEditorProps {
  set: FlashcardSetDetail
  onBack: () => void
  onStudy: (mode: 'flashcards' | 'learn' | 'test' | 'match') => void
  onUpdated: (set: FlashcardSetDetail) => void
  onDelete: () => void
}

export function FlashcardSetEditor({ set, onBack, onStudy, onUpdated, onDelete }: FlashcardSetEditorProps) {
  const [title, setTitle] = useState(set.title)
  const [description, setDescription] = useState(set.description ?? '')
  const [cards, setCards] = useState(set.cards)
  const [importOpen, setImportOpen] = useState(false)
  const [paste, setPaste] = useState('')
  const [saving, setSaving] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  useEffect(() => { setTitle(set.title); setDescription(set.description ?? ''); setCards(set.cards) }, [set])

  const persistSet = async () => {
    setSaving(true)
    try { const updated = await api.saveSet({ id: set.id, title: title.trim() || 'Untitled set', description: description.trim() || null }); onUpdated(updated) } finally { setSaving(false) }
  }
  const addCard = async () => {
    const card = await api.saveCard({ setId: set.id, front: '', back: '', position: cards.length, isStarred: false })
    setCards((previous) => [...previous, card])
  }
  const updateCard = (id: string, partial: Partial<Flashcard>) => setCards((previous) => previous.map((card) => card.id === id ? { ...card, ...partial } : card))
  const persistCard = async (card: Flashcard) => {
    const saved = await api.saveCard(card)
    setCards((previous) => previous.map((item) => item.id === saved.id ? saved : item))
  }
  const removeCard = async (id: string) => { await api.deleteCard(id); setCards((previous) => previous.filter((card) => card.id !== id)) }
  const reorder = async (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return
    setCards((previous) => {
      const from = previous.findIndex((card) => card.id === event.active.id)
      const to = previous.findIndex((card) => card.id === event.over?.id)
      const next = [...previous]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      const ordered = next.map((card, index) => ({ ...card, position: index }))
      void Promise.all(ordered.map((card) => api.saveCard(card)))
      return ordered
    })
  }
  const importCards = async () => {
    const rows = paste.split(/\r?\n/).map((line) => line.split('\t')).filter(([front, back]) => front?.trim() && back?.trim())
    const created = await Promise.all(rows.map(([front, back], index) => api.saveCard({ setId: set.id, front: front.trim(), back: back.trim(), position: cards.length + index, isStarred: false })))
    setCards((previous) => [...previous, ...created])
    setPaste(''); setImportOpen(false)
  }
  return <main className="set-editor">
    <header className="set-editor-header"><button className="back-button" onClick={onBack}><ChevronLeft size={18} /> Flashcards</button><div className="set-status">{saving ? 'Saving…' : 'Saved locally'}</div><button className="editor-action danger" onClick={onDelete}>Move to trash</button></header>
    <section className="set-editor-main"><div className="set-heading"><span className="set-heading-icon"><BookOpen size={23} /></span><div><label className="set-title-field"><span>Set name</span><input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => void persistSet()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} placeholder="Untitled flashcard set" aria-label="Flashcard set title" /></label><textarea value={description} onChange={(event) => setDescription(event.target.value)} onBlur={() => void persistSet()} placeholder="Add an optional description" aria-label="Flashcard set description" rows={1} /></div></div>
      <div className="study-launcher"><span>{cards.length} {cards.length === 1 ? 'card' : 'cards'}</span><div><button className="button button-soft button-small" onClick={() => onStudy('flashcards')} disabled={!cards.length}>Flashcards</button><button className="button button-soft button-small" onClick={() => onStudy('test')} disabled={!cards.length}>Test</button><button className="button button-soft button-small" onClick={() => onStudy('match')} disabled={!cards.length}>Match</button><button className="button button-primary button-small" onClick={() => onStudy('learn')} disabled={!cards.length}><Sparkles size={15} /> Learn</button></div></div>
      <div className="set-editor-actions"><button className="button button-quiet button-small" onClick={() => setImportOpen((open) => !open)}><ClipboardPaste size={15} /> Bulk paste</button><button className="button button-primary button-small" onClick={() => void addCard()}><Plus size={15} /> Add card</button></div>
      {importOpen && <div className="bulk-import"><div><strong>Paste terms and definitions</strong><p>One card per line. Separate the front and back with a tab.</p></div><textarea value={paste} onChange={(event) => setPaste(event.target.value)} placeholder={'Mitosis\tCell division that produces two identical cells\nMeiosis\tCell division that produces reproductive cells'} /><div><button className="button button-quiet button-small" onClick={() => setImportOpen(false)}>Cancel</button><button className="button button-primary button-small" disabled={!paste.trim()} onClick={() => void importCards()}>Import cards</button></div></div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}><SortableContext items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}><div className="card-editor-list">{cards.map((card, index) => <EditableCard key={card.id} card={card} index={index} onChange={updateCard} onPersist={persistCard} onRemove={removeCard} />)}</div></SortableContext></DndContext>
      {!cards.length && <div className="set-empty"><BookOpen size={25} /><h2>Start with your first card.</h2><p>Use a term on the front and the explanation on the back.</p><button className="button button-primary" onClick={() => void addCard()}><Plus size={16} /> Add a card</button></div>}
    </section>
  </main>
}

function EditableCard({ card, index, onChange, onPersist, onRemove }: { card: Flashcard; index: number; onChange: (id: string, partial: Partial<Flashcard>) => void; onPersist: (card: Flashcard) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const sortable = useSortable({ id: card.id })
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable
  const style = { transform: CSS.Transform.toString(transform), transition }
  return <article className={`editable-card ${isDragging ? 'dragging' : ''}`} ref={setNodeRef} style={style}>
    <div className="card-row-tools"><button className="drag-handle" aria-label={`Reorder card ${index + 1}`} {...attributes} {...listeners}><GripVertical size={17} /></button><span>{index + 1}</span></div>
    <label><span>Front</span><textarea value={card.front} onChange={(event) => onChange(card.id, { front: event.target.value })} onBlur={() => void onPersist(card)} onKeyDown={(event) => { if (event.key === 'Tab' && !event.shiftKey) event.currentTarget.closest('.editable-card')?.querySelector<HTMLTextAreaElement>('[data-card-back]')?.focus() }} placeholder="Term" rows={2} /></label>
    <label><span>Back</span><textarea data-card-back value={card.back} onChange={(event) => onChange(card.id, { back: event.target.value })} onBlur={() => void onPersist(card)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void onPersist(card) } }} placeholder="Definition" rows={2} /></label>
    <div className="card-actions"><button className={card.isStarred ? 'card-action starred' : 'card-action'} onClick={() => { const next = { ...card, isStarred: !card.isStarred }; onChange(card.id, { isStarred: next.isStarred }); void onPersist(next) }} aria-label="Star card"><Star size={16} fill={card.isStarred ? 'currentColor' : 'none'} /></button><button className="card-action delete" onClick={() => void onRemove(card.id)} aria-label="Delete card"><Trash2 size={16} /></button></div>
  </article>
}
