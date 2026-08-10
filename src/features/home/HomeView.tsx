import { ArrowRight, BookOpen, FilePlus2, FolderPlus, GraduationCap, Layers3, Plus } from 'lucide-react'
import { useState } from 'react'
import type { CourseClass, DocumentSummary, Semester } from '../../lib/types'
import { classLabel, formatDate } from '../../lib/format'

interface HomeViewProps {
  semesters: Semester[]
  classes: CourseClass[]
  recentDocuments: DocumentSummary[]
  userName: string
  onNewSemester: () => void
  onNewClass: () => void
  onOpenClass: (classId: string) => void
  onOpenDocument: (document: DocumentSummary) => void
}

export function HomeView({ semesters, classes, recentDocuments, userName, onNewSemester, onNewClass, onOpenClass, onOpenDocument }: HomeViewProps) {
  const [showAllRecents, setShowAllRecents] = useState(false)
  if (!semesters.length) return <EmptyLibrary onNewSemester={onNewSemester} />
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  return <main className="home-view content-view">
    <header className="view-intro"><p className="eyebrow">SOFLO</p><h1>{userName ? `${greeting}, ${userName}.` : `${greeting}.`}</h1><p>Pick up where you left off, or start something new.</p></header>
    <section className="home-section">
      <div className="section-heading"><div><h2>Recent</h2><p>Your latest papers, always close at hand.</p></div><button className="text-button" onClick={() => setShowAllRecents((current) => !current)}>{showAllRecents ? 'Fewer recents' : 'More recents'} <ArrowRight size={15} /></button></div>
      {recentDocuments.length ? <div className="recent-list">{(showAllRecents ? recentDocuments : recentDocuments.slice(0, 4)).map((document) => {
        const course = classes.find((item) => item.id === document.classId)
        return <button className="recent-item" key={document.id} onClick={() => onOpenDocument(document)}><span className="recent-icon"><FilePlus2 size={19} /></span><span className="recent-copy"><strong>{document.title}</strong><small>{course ? classLabel(course) : 'Class paper'} · {formatDate(document.updatedAt)}</small></span><ArrowRight size={17} /></button>
      })}</div> : <div className="quiet-empty"><FilePlus2 size={22} /><p>Papers you create will appear here.</p></div>}
    </section>
    <section className="home-section">
      <div className="section-heading"><div><h2>Classes</h2><p>Everything in its place.</p></div><button className="button button-primary button-small" onClick={onNewClass}><Plus size={15} /> New class</button></div>
      <div className="class-grid">{classes.map((course) => <button className="class-card" key={course.id} onClick={() => onOpenClass(course.id)} style={{ '--course-accent': course.accentColor } as React.CSSProperties}>
        <span className="class-card-icon"><BookOpen size={20} /></span><span className="class-card-copy"><strong>{classLabel(course)}</strong><small>{course.name}</small></span><ArrowRight size={17} /></button>)}</div>
    </section>
  </main>
}

function EmptyLibrary({ onNewSemester }: { onNewSemester: () => void }) {
  return <main className="empty-library content-view">
    <div className="empty-orb"><GraduationCap size={30} /></div>
    <p className="eyebrow">WELCOME TO SOFLO</p><h1>A calm place for<br />serious learning.</h1>
    <p>Start by adding the semester you’re in. From there, SoFlo will keep every class, paper, and study session beautifully organized.</p>
    <button className="button button-primary" onClick={onNewSemester}><Plus size={17} /> Create your first semester</button>
    <div className="empty-library-notes"><span><Layers3 size={16} /> Everything stays on this computer</span><span><FolderPlus size={16} /> Built around your classes</span></div>
  </main>
}
