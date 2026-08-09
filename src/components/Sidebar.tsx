import { Archive, CalendarDays, ChevronDown, ChevronRight, CircleHelp, Home, MoreHorizontal, Plus, Search, Settings } from 'lucide-react'
import type { AppView, CourseClass, Semester } from '../lib/types'
import { classLabel } from '../lib/format'

interface SidebarProps {
  semesters: Semester[]
  classes: CourseClass[]
  activeView: AppView
  collapsed: boolean
  onNavigate: (view: AppView) => void
  onNewSemester: () => void
  onNewClass: (semesterId?: string) => void
  onOpenCommand: () => void
}

export function Sidebar({ semesters, classes, activeView, collapsed, onNavigate, onNewSemester, onNewClass, onOpenCommand }: SidebarProps) {
  return <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <div className="sidebar-scroll">
      <nav className="primary-nav" aria-label="Main navigation">
        <button className={activeView.kind === 'home' ? 'nav-item active' : 'nav-item'} onClick={() => onNavigate({ kind: 'home' })}><Home size={17} /><span>Home</span></button>
        <button className="nav-item" onClick={onOpenCommand}><Search size={17} /><span>Search</span><kbd>Ctrl K</kbd></button>
      </nav>
      <div className="sidebar-section-heading"><span>Semesters</span><button className="icon-button tiny" onClick={onNewSemester} title="New semester" aria-label="New semester"><Plus size={15} /></button></div>
      <div className="semester-list">
        {semesters.length === 0 && <button className="sidebar-empty" onClick={onNewSemester}>Create your first semester</button>}
        {semesters.map((semester) => {
          const classesForSemester = classes.filter((course) => course.semesterId === semester.id)
          return <div className="semester-group" key={semester.id}>
            <div className="semester-label"><ChevronDown size={14} /><span>{semester.name || `${semester.term} ${semester.year}`}</span><button className="semester-add" onClick={() => onNewClass(semester.id)} aria-label={`Add class to ${semester.name}`}><Plus size={14} /></button></div>
            {classesForSemester.map((course) => <button className={activeView.kind !== 'home' && 'classId' in activeView && activeView.classId === course.id ? 'class-nav active' : 'class-nav'} onClick={() => onNavigate({ kind: 'class', classId: course.id, tab: 'overview' })} key={course.id}>
              <span className="class-dot" style={{ background: course.accentColor }} /><span>{classLabel(course)}</span>
            </button>)}
            {classesForSemester.length === 0 && <button className="class-nav muted" onClick={() => onNewClass(semester.id)}><ChevronRight size={13} /><span>Add a class</span></button>}
          </div>
        })}
      </div>
      <div className="sidebar-calendar"><div className="sidebar-section-heading"><span>Calendar</span></div><button className={activeView.kind === 'calendar' ? 'nav-item active' : 'nav-item'} onClick={() => onNavigate({ kind: 'calendar' })}><CalendarDays size={17} /><span>Today</span></button></div>
    </div>
    <nav className="sidebar-bottom">
      <button className={activeView.kind === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => onNavigate({ kind: 'settings' })}><Settings size={17} /><span>Settings</span></button>
      <button className={activeView.kind === 'archive' ? 'nav-item active' : 'nav-item'} onClick={() => onNavigate({ kind: 'archive' })}><Archive size={17} /><span>Archived classes</span></button>
      <button className={activeView.kind === 'help' ? 'nav-item active' : 'nav-item muted'} onClick={() => onNavigate({ kind: 'help' })} aria-label="SoFlo help"><CircleHelp size={17} /><span>Help</span></button>
    </nav>
  </aside>
}

export function CompactClassActions({ onAction }: { onAction: () => void }) {
  return <button className="icon-button" aria-label="Class actions" onClick={onAction}><MoreHorizontal size={18} /></button>
}

export function ArchiveLabel() {
  return <span className="archive-label"><Archive size={13} /> Archived</span>
}
