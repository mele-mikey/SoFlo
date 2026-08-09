import { Archive, RotateCcw } from 'lucide-react'
import type { CourseClass, Semester } from '../../lib/types'

export function ArchiveView({ semesters, classes, onRestore }: { semesters: Semester[]; classes: CourseClass[]; onRestore: (course: CourseClass) => void }) {
  const archived = classes.filter((course) => course.archivedAt)
  return <main className="content-view archive-view"><header className="view-intro"><p className="eyebrow">PAST CLASSES</p><h1>Archived classes</h1><p>Completed work stays out of the way, never out of reach.</p></header>{archived.length ? <div className="archive-list">{archived.map((course) => <article key={course.id} className="archive-row"><span className="archive-course-dot" style={{ background: course.accentColor }} /><div><strong>{course.courseCode || course.name}</strong><small>{course.name} · {semesters.find((semester) => semester.id === course.semesterId)?.name ?? 'Past semester'}</small></div><button className="button button-soft button-small" onClick={() => onRestore(course)}><RotateCcw size={14} /> Restore</button></article>)}</div> : <div className="section-blank"><Archive size={26} /><h2>Nothing archived yet.</h2><p>When a class ends, archive it to keep the current semester quiet while preserving everything inside.</p></div>}</main>
}
