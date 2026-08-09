import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { BookOpen, ChevronLeft, Download, GripVertical, MoreHorizontal, Plus, Sparkles, Star, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import type { Flashcard, FlashcardSetDetail } from '../../lib/types'

interface FlashcardSetEditorProps {
  set: FlashcardSetDetail
  onBack: () => void
  onStudy: (mode: 'flashcards' | 'learn' | 'test' | 'match') => void
  onUpdated: (set: FlashcardSetDetail) => void
  onDelete: () => void
  onToast: (message: string, kind?: 'success' | 'error') => void
}

export function FlashcardSetEditor({ set, onBack, onStudy, onUpdated, onDelete, onToast }: FlashcardSetEditorProps) {
  const [title, setTitle] = useState(set.title)
  const [description, setDescription] = useState(set.description ?? '')
  const [cards, setCards] = useState(set.cards)
  const [saving, setSaving] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [focusCardId, setFocusCardId] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  useEffect(() => { setTitle(set.title); setDescription(set.description ?? ''); setCards(set.cards) }, [set])

  const persistSet = async () => {
    setSaving(true)
    try { const updated = await api.saveSet({ id: set.id, title: title.trim() || 'Untitled set', description: description.trim() || null }); onUpdated(updated) } finally { setSaving(false) }
  }
  const mastery = useMemo(() => set.progress.reduce<Record<string, number>>((summary, item) => { summary[item.mastery] = (summary[item.mastery] ?? 0) + 1; return summary }, {}), [set.progress])
  const addCard = async (focus = false) => {
    const card = await api.saveCard({ setId: set.id, front: '', back: '', position: cards.length, isStarred: false })
    setCards((previous) => [...previous, card])
    if (focus) setFocusCardId(card.id)
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
  const exportCards = async () => {
    setMoreOpen(false)
    try { await api.exportFlashcardSetText(set.id); onToast('Flashcards exported to Downloads.') } catch (error) { onToast(error instanceof Error ? error.message : 'Flashcards could not be exported.', 'error') }
  }
  return <main className="set-editor">
    <header className="set-editor-header"><button className="back-button" onClick={onBack}><ChevronLeft size={18} /> Flashcards</button><div className="set-status">{saving ? 'Saving…' : 'Saved locally'}</div></header>
    <section className="set-editor-main"><div className="set-heading"><span className="set-heading-icon"><BookOpen size={23} /></span><div><label className="set-title-field"><span>Set name</span><input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => void persistSet()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} placeholder="Untitled flashcard set" aria-label="Flashcard set title" /></label><textarea value={description} onChange={(event) => setDescription(event.target.value)} onBlur={() => void persistSet()} placeholder="Add an optional description" aria-label="Flashcard set description" rows={1} /></div></div>
      <div className="set-mastery-summary"><strong>{cards.length} {cards.length === 1 ? 'Card' : 'Cards'}</strong><span>{mastery.mastered ?? 0} Mastered</span><span>{mastery.familiar ?? 0} Familiar</span><span>{mastery.learning ?? 0} Learning</span><span>{mastery.needsWork ?? 0} Need work</span></div>
      <div className="study-launcher"><span>Everything saves locally as you work.</span><div><button className="button button-primary button-small" onClick={() => onStudy('learn')} disabled={!cards.length}><Sparkles size={15} /> Study</button><span className="set-more"><button className="icon-button tiny" onClick={() => setMoreOpen((open) => !open)} aria-label="Flashcard set settings"><MoreHorizontal size={17} /></button>{moreOpen && <span className="paper-action-menu"><button onClick={() => void exportCards()}><Download size={14} /> Export</button><button className="danger" onClick={() => { setMoreOpen(false); onDelete() }}><Trash2 size={14} /> Move to trash</button></span>}</span></div></div>
      <div className="set-editor-actions"><button className="button button-primary button-small" onClick={() => void addCard()}><Plus size={15} /> Add card</button></div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}><SortableContext items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}><div className="card-editor-list">{cards.map((card, index) => <EditableCard key={card.id} card={card} index={index} autoFocus={focusCardId === card.id} onChange={updateCard} onPersist={persistCard} onCreateNext={() => void addCard(true)} onRemove={removeCard} />)}</div></SortableContext></DndContext>
      {!cards.length && <div className="set-empty"><BookOpen size={25} /><h2>Start with your first card.</h2><p>Use a term on the front and the explanation on the back.</p><button className="button button-primary" onClick={() => void addCard()}><Plus size={16} /> Add a card</button></div>}
    </section>
  </main>
}

function EditableCard({ card, index, autoFocus, onChange, onPersist, onCreateNext, onRemove }: { card: Flashcard; index: number; autoFocus: boolean; onChange: (id: string, partial: Partial<Flashcard>) => void; onPersist: (card: Flashcard) => Promise<void>; onCreateNext: () => void; onRemove: (id: string) => Promise<void> }) {
  const sortable = useSortable({ id: card.id })
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable
  const style = { transform: CSS.Transform.toString(transform), transition }
  const termInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (autoFocus) termInput.current?.focus() }, [autoFocus])
  return <article className={`editable-card ${isDragging ? 'dragging' : ''}`} ref={setNodeRef} style={style}>
    <div className="card-row-tools"><button className="drag-handle" aria-label={`Reorder card ${index + 1}`} {...attributes} {...listeners}><GripVertical size={17} /></button><span>{index + 1}</span></div>
    <label><span>Term</span><textarea ref={termInput} value={card.front} onChange={(event) => onChange(card.id, { front: event.target.value })} onBlur={() => void onPersist(card)} onKeyDown={(event) => { if (event.key === 'Tab' && !event.shiftKey) event.currentTarget.closest('.editable-card')?.querySelector<HTMLTextAreaElement>('[data-card-back]')?.focus() }} placeholder="Term" rows={2} /></label>
    <label><span>Definition</span><textarea data-card-back value={card.back} onChange={(event) => onChange(card.id, { back: event.target.value })} onBlur={() => void onPersist(card)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void onPersist(card).then(onCreateNext) } }} placeholder="Definition" rows={2} /></label>
    <div className="card-actions"><button className={card.isStarred ? 'card-action starred' : 'card-action'} onClick={() => { const next = { ...card, isStarred: !card.isStarred }; onChange(card.id, { isStarred: next.isStarred }); void onPersist(next) }} aria-label="Star card"><Star size={16} fill={card.isStarred ? 'currentColor' : 'none'} /></button><button className="card-action delete" onClick={() => void onRemove(card.id)} aria-label="Delete card"><Trash2 size={16} /></button></div>
  </article>
}
