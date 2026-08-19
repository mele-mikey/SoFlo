import { open } from '@tauri-apps/plugin-dialog'
import { ArrowLeft, CalendarDays, Check, FileText, FileUp, RefreshCw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import type { CourseCalendarDetail, CourseCalendarItem, CourseCalendarSource, CourseClass } from '../../lib/types'

type Toast = (message: string, kind?: 'success' | 'error') => void
const emptyCalendar = (classId: string): CourseCalendarDetail => ({ classId, sources: [], items: [], gamePlan: '', updatedAt: null })
const isoDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const shortDate = (date: Date) => date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

export function CourseCalendarView({ course, aiEnabled, onEnsureAiModel, onToast }: { course: CourseClass; aiEnabled: boolean; onEnsureAiModel: () => Promise<string | null>; onToast: Toast }) {
  const [calendar, setCalendar] = useState<CourseCalendarDetail>(() => emptyCalendar(course.id))
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<CourseCalendarItem | null>(null)
  const [reading, setReading] = useState<CourseCalendarSource | null>(null)
  const load = useCallback(async () => { setLoading(true); try { setCalendar(await api.getCourseCalendar(course.id)) } catch (error) { onToast(error instanceof Error ? error.message : 'Course Calendar could not be opened.', 'error') } finally { setLoading(false) } }, [course.id, onToast])
  useEffect(() => { void load() }, [load])
  const days = useMemo(() => { const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); return Array.from({ length: 5 }, (_, index) => { const date = new Date(monday); date.setDate(monday.getDate() + index); return { date, iso: isoDate(date) } }) }, [])
  const itemSource = selected ? calendar.sources.find((source) => source.id === selected.sourceId) : null
  const addDocuments = async () => {
    const remaining = 10 - calendar.sources.length
    if (remaining <= 0) { onToast('This Course Calendar already has 10 source documents. Remove one before adding another.', 'error'); return }
    const picked = await open({ title: 'Add course documents', multiple: true, directory: false, filters: [{ name: 'Course documents', extensions: ['pdf', 'doc', 'docx'] }] })
    const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).slice(0, remaining)
    if (!paths.length) return
    try {
      for (const path of paths) {
        const text = /\.docx?$/i.test(path) ? await api.importWordText(path) : await api.importPdfText(path)
        const title = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Course document'
        await api.addCourseCalendarSource({ classId: course.id, title, contentPlain: text, sourcePath: path })
      }
      await load()
      onToast(`${paths.length} course document${paths.length === 1 ? '' : 's'} added.`)
    } catch (error) { onToast(error instanceof Error ? error.message : 'That course document could not be added.', 'error') }
  }
  const refresh = async () => {
    if (!calendar.sources.length) { onToast('Add one or more course documents first.', 'error'); return }
    if (!aiEnabled) { onToast('Enable General AI in Settings to build this calendar.', 'error'); return }
    setRefreshing(true)
    try {
      const modelPath = await onEnsureAiModel()
      if (!modelPath) return
      setCalendar(await api.refreshCourseCalendar(course.id, modelPath))
      setSelected(null)
      onToast('Course Calendar refreshed.')
    } catch (error) { onToast(error instanceof Error ? error.message : 'Course Calendar could not be refreshed.', 'error') } finally { setRefreshing(false) }
  }
  const removeSource = async (source: CourseCalendarSource) => { try { await api.removeCourseCalendarSource(source.id); if (selected?.sourceId === source.id) setSelected(null); await load(); onToast('Course document removed.') } catch (error) { onToast(error instanceof Error ? error.message : 'Course document could not be removed.', 'error') } }
  const toggleItem = async (item: CourseCalendarItem) => { try { await api.setCourseCalendarItemCompleted(item.id, !item.completed); setCalendar((current) => ({ ...current, items: current.items.map((entry) => entry.id === item.id ? { ...entry, completed: !entry.completed } : entry) })); setSelected((current) => current?.id === item.id ? { ...current, completed: !item.completed } : current) } catch (error) { onToast(error instanceof Error ? error.message : 'Completion could not be updated.', 'error') } }
  if (reading) return <section className="course-calendar-source-page"><button className="button button-quiet button-small" onClick={() => setReading(null)}><ArrowLeft size={15} /> Back to Course Calendar</button><p className="eyebrow">COURSE SOURCE · READ ONLY</p><h2>{reading.title}</h2><p className="course-calendar-source-note">This is the saved source used to build your class plan.</p><article>{reading.contentPlain}</article></section>
  if (loading) return <div className="content-loading"><i />Loading Course Calendar…</div>
  return <section className="course-calendar"><header className="course-calendar-heading"><div><p className="eyebrow">AI COURSE PLANNER</p><h2>Course Calendar</h2><p>Bring in up to 10 course documents and turn them into a workable week.</p></div><div className="course-calendar-actions"><button className="button button-soft button-small ai-action" onClick={() => void addDocuments()}><FileUp size={15} /> Add course documents</button><button className="button button-primary button-small ai-action" disabled={!calendar.sources.length || refreshing} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh AI'}</button></div></header>
    <div className="course-calendar-layout"><div className="course-calendar-main"><div className="course-calendar-week">{days.map(({ date, iso }) => { const events = calendar.items.filter((item) => item.dueDate === iso); return <section className="course-calendar-day" key={iso}><header><strong>{date.toLocaleDateString(undefined, { weekday: 'long' })}</strong><small>{shortDate(date)}</small></header><div className="course-calendar-events">{events.map((item) => <button key={item.id} className={`course-calendar-event urgency-${item.urgency}${item.completed ? ' completed' : ''}`} onClick={() => setSelected(item)}><span>{item.completed ? <Check size={13} /> : <CalendarDays size={13} />}</span><strong>{item.title}</strong><small>{item.completed ? 'Completed' : item.urgency}</small></button>)}{!events.length && <p>No due items.</p>}</div></section> })}</div>{calendar.items.filter((item) => !days.some((day) => day.iso === item.dueDate)).length > 0 && <section className="course-calendar-later"><strong>Later or outside this week</strong>{calendar.items.filter((item) => !days.some((day) => day.iso === item.dueDate)).slice(0, 8).map((item) => <button key={item.id} className={`urgency-${item.urgency}${item.completed ? ' completed' : ''}`} onClick={() => setSelected(item)}>{item.dueDate} · {item.title}</button>)}</section>}</div><aside className="course-calendar-sidebar"><section className="course-calendar-plan"><div><p className="eyebrow">GAME PLAN</p><h3>What to do first</h3></div><p>{calendar.gamePlan || (calendar.sources.length ? 'Refresh with AI to create a priority-aware plan from your course documents.' : 'Add course documents, then SoFlo can build your plan.')}</p></section><section className="course-calendar-sources"><div><h3>Course documents</h3><small>{calendar.sources.length}/10 saved</small></div>{calendar.sources.length ? calendar.sources.map((source) => <article key={source.id}><button onClick={() => setReading(source)}><FileText size={15} /><span>{source.title}</span></button><button className="icon-button tiny" onClick={() => void removeSource(source)} aria-label={`Remove ${source.title}`}><Trash2 size={14} /></button></article>) : <p>No saved documents yet.</p>}</section></aside></div>
    {selected && <div className="paper-dialog-backdrop"><section className="paper-dialog course-calendar-detail" role="dialog" aria-modal="true" aria-label="Course calendar item"><header><div><p className="eyebrow">DUE {selected.dueDate}</p><h2>{selected.title}</h2></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close"><X size={17} /></button></header><div className="paper-dialog-content"><p>{selected.description || 'Review the linked course document for the assignment details.'}</p>{selected.sourceExcerpt && <blockquote>{selected.sourceExcerpt}</blockquote>}{itemSource && <button className="text-button course-calendar-source-link" onClick={() => { setSelected(null); setReading(itemSource) }}>Open {itemSource.title}<ArrowLeft size={14} /></button>}</div><footer><button className={`button button-small ${selected.completed ? 'button-soft' : 'button-primary'}`} onClick={() => void toggleItem(selected)}>{selected.completed ? 'Mark incomplete' : <><Check size={15} /> Mark complete</>}</button></footer></section></div>}
  </section>
}
