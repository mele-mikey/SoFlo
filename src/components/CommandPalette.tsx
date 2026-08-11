import { Command } from 'cmdk'
import { Archive, BookOpen, CalendarDays, FilePlus2, FolderPlus, GraduationCap, House, Search, Settings, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { AppView, CourseClass, SearchResult } from '../lib/types'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  classes: CourseClass[]
  onNavigate: (view: AppView) => void
  onNewNote: () => void
  onNewSet: () => void
}

export function CommandPalette({ open, onOpenChange, classes, onNavigate, onNewNote, onNewSet }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = window.setTimeout(() => { void api.search(query).then(setResults).catch(() => setResults([])) }, 140)
    return () => window.clearTimeout(timer)
  }, [query])
  useEffect(() => { if (!open) setQuery('') }, [open])
  if (!open) return null
  const choose = (view: AppView) => { onNavigate(view); onOpenChange(false) }
  return <div className="command-backdrop" onMouseDown={() => onOpenChange(false)}>
    <Command className="command-palette" label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
      <div className="command-input-wrap"><Search size={18} /><Command.Input autoFocus value={query} onValueChange={setQuery} placeholder="Search your library or run a command…" /><kbd>Esc</kbd></div>
      <Command.List>
        <Command.Empty>No results found.</Command.Empty>
        <Command.Group heading={query ? 'Pages & actions' : 'Quick actions'}>
          <Command.Item onSelect={onNewNote}><FilePlus2 size={16} />New paper</Command.Item>
          <Command.Item onSelect={onNewSet}><BookOpen size={16} />New flashcard set</Command.Item>
          <Command.Item onSelect={() => choose({ kind: 'home' })}><House size={16} />Overview</Command.Item>
          <Command.Item onSelect={() => choose({ kind: 'calendar' })}><CalendarDays size={16} />Calendar</Command.Item>
          <Command.Item onSelect={() => choose({ kind: 'help' })}><GraduationCap size={16} />Help and walkthrough</Command.Item>
          <Command.Item onSelect={() => choose({ kind: 'archive' })}><Archive size={16} />Archived classes</Command.Item>
          <Command.Item onSelect={() => choose({ kind: 'settings' })}><Settings size={16} />Settings · personal, appearance, security, AI models, library data</Command.Item>
        </Command.Group>
        {!query && <>
          <Command.Group heading="Classes">
            {classes.map((course) => <Command.Item key={course.id} onSelect={() => choose({ kind: 'class', classId: course.id, tab: 'overview' })}><FolderPlus size={16} />{course.courseCode || course.name}<span className="command-item-detail">{course.name}</span></Command.Item>)}
          </Command.Group>
        </>}
        {query && <Command.Group heading="Library">
          {results.map((result) => <Command.Item key={`${result.kind}-${result.id}`} value={`${result.title} ${result.subtitle}`} onSelect={() => {
            if (result.kind === 'document' && result.parentId) choose({ kind: 'document', classId: result.parentId, documentId: result.id })
            else if (result.kind === 'lecture' && result.parentId) choose({ kind: 'lecture', classId: result.parentId, lectureId: result.id })
            else if (result.kind === 'set' && result.parentId) choose({ kind: 'flashcardSet', classId: result.parentId, setId: result.id })
            else if (result.kind === 'class') choose({ kind: 'class', classId: result.id, tab: 'overview' })
            else if (result.kind === 'card' && result.parentId) choose({ kind: 'class', classId: result.parentId, tab: 'flashcards' })
          }}><Sparkles size={15} /><span>{result.title}</span><span className="command-item-detail">{result.subtitle}</span></Command.Item>)}
        </Command.Group>}
      </Command.List>
      <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>↵</kbd> to select</span></div>
    </Command>
  </div>
}
