import { CalendarDays, Clock3, MoreHorizontal, NotebookPen, Plus, Trash2, UserRound, X } from 'lucide-react'
import { useState } from 'react'
import type { LectureSummary } from '../../lib/types'

interface LecturesViewProps {
  lectures: LectureSummary[]
  onCreate: () => void
  onOpen: (lecture: LectureSummary) => void
  onDelete: (lecture: LectureSummary) => void
}

function formatLectureDate(value: string) {
  const date = new Date(`${value}T12:00:00`)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

function formatTime(value: string | null) {
  if (!value) return null
  const [hourValue, minute = '00'] = value.split(':')
  const hour = Number(hourValue)
  if (Number.isNaN(hour)) return value
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`
}

function timeRange(lecture: LectureSummary) {
  const start = formatTime(lecture.scheduledStart)
  const end = formatTime(lecture.scheduledEnd)
  return start && end ? `${start} – ${end}` : start ?? 'No class meeting scheduled'
}

export function LecturesView({ lectures, onCreate, onOpen, onDelete }: LecturesViewProps) {
  const [pendingDelete, setPendingDelete] = useState<LectureSummary | null>(null)

  return <section className="lectures-view">
    <div className="section-heading">
      <div>
        <h2>Lectures</h2>
        <p>Keep a dated, searchable record of every class meeting.</p>
      </div>
      {lectures.length > 0 && <button className="button button-primary button-small" onClick={onCreate}><Plus size={15} /> New lecture</button>}
    </div>
    {lectures.length ? <div className="lecture-list">{lectures.map((lecture) => <article className="lecture-row" key={lecture.id}>
      <button className="lecture-row-main" onClick={() => onOpen(lecture)}>
        <span className="lecture-row-icon"><NotebookPen size={19} /></span>
        <span className="lecture-row-content">
          <strong>{lecture.title}</strong>
          <small><CalendarDays size={13} />{formatLectureDate(lecture.lectureDate)} <span>·</span> <Clock3 size={13} />{timeRange(lecture)}</small>
          {lecture.professorSnapshot && <small><UserRound size={13} />{lecture.professorSnapshot}</small>}
          <em>{lecture.excerpt || 'No notes yet.'}</em>
        </span>
      </button>
      <div className="paper-row-actions">
        <button className="icon-button tiny" aria-label={`Lecture settings for ${lecture.title}`} onClick={() => setPendingDelete(lecture)}><MoreHorizontal size={17} /></button>
      </div>
    </article>)}</div> : <div className="section-blank lecture-empty">
      <NotebookPen size={28} />
      <h2>Start your first lecture.</h2>
      <p>Create a dated note for today’s class. SoFlo will capture the course, professor, and scheduled time automatically.</p>
      <button className="button button-primary" onClick={onCreate}><Plus size={16} /> New lecture</button>
    </div>}
    {pendingDelete && <div className="paper-dialog-backdrop" role="presentation">
      <section className="paper-dialog" role="dialog" aria-modal="true" aria-label="Delete lecture">
        <header><div><p className="eyebrow">PERMANENT ACTION</p><h2>Delete this lecture?</h2></div><button className="icon-button" onClick={() => setPendingDelete(null)} aria-label="Cancel deletion"><X size={17} /></button></header>
        <div className="paper-dialog-content"><p><strong>{pendingDelete.title}</strong> and its notes will be permanently deleted. This cannot be undone.</p></div>
        <footer><button className="button button-quiet" onClick={() => setPendingDelete(null)}>Cancel</button><button className="button button-danger" onClick={() => { onDelete(pendingDelete); setPendingDelete(null) }}><Trash2 size={15} /> Delete lecture</button></footer>
      </section>
    </div>}
  </section>
}
