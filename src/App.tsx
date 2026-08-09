import { Menu, Plus, Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import './App.css'
import sofloMark from '../src-tauri/icons/128x128.png'
import { CommandPalette } from './components/CommandPalette'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { api } from './lib/api'
import type { AppSettings, AppView, BootstrapData, CourseClass, DocumentDetail, DocumentFolder, DocumentSummary, Flashcard, FlashcardSetDetail, FlashcardSetSummary, LectureDetail, LectureSummary, SecurityStatus, Semester } from './lib/types'
import { ClassView } from './features/classes/ClassView'
import { DocumentEditor } from './features/editor/DocumentEditor'
import { importAiFormattedNote, importPdfAsEditableNote } from './features/editor/pdfImport'
import { FlashcardSetEditor } from './features/flashcards/FlashcardSetEditor'
import { HomeView } from './features/home/HomeView'
import { CalendarView } from './features/calendar/CalendarView'
import { WelcomeView } from './features/onboarding/WelcomeView'
import { LockView } from './features/onboarding/LockView'
import { CreateClassDialog, CreateSemesterDialog } from './features/organization/CreateDialogs'
import { ArchiveView } from './features/organization/ArchiveView'
import { SettingsView } from './features/settings/SettingsView'
import { HelpView } from './features/help/HelpView'
import { StudyView } from './features/study/StudyView'

type ModalState = { type: 'semester' } | { type: 'class'; semesterId?: string } | { type: 'aiSet'; classId: string } | { type: 'importSet'; classId: string } | { type: 'restartWalkthrough' } | null
type ToastKind = 'success' | 'error'
type Toast = { message: string; type: ToastKind } | null
type AiSetRequest = { sources: string[]; pasted: string; topic: string; guidance: string; title: string; cardCount: 'auto' | 10 | 20 | 30; depth: 'quick' | 'standard' | 'detailed' }
type AiProgress = { progress: number; message: string }

function aiFailureMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.trim()) return error.message
  return 'SoFlo could not create flashcards. Please try again.'
}

function localDateKey(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.valueOf() - offset).toISOString().slice(0, 10)
}

function toTwentyFourHour(value: string) {
  const match = value.trim().match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i)
  if (!match) return value.trim() || null
  let hour = Number(match[1]) % 12
  if (match[3].toUpperCase() === 'PM') hour += 12
  return `${String(hour).padStart(2, '0')}:${match[2] ?? '00'}`
}

function todayMeeting(schedule: string | null) {
  if (!schedule) return { start: null, end: null }
  const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()]
  const escapedDay = today.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = schedule.match(new RegExp(`\\b${escapedDay}\\s+(\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM))\\s*-\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM))`, 'i'))
  return match ? { start: toTwentyFourHour(match[1]), end: toTwentyFourHour(match[2]) } : { start: null, end: null }
}

function App() {
  const [library, setLibrary] = useState<BootstrapData | null>(null)
  const [security, setSecurity] = useState<SecurityStatus | null>(null)
  const [booting, setBooting] = useState(true)
  const [view, setView] = useState<AppView>({ kind: 'home' })
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [documentFolders, setDocumentFolders] = useState<DocumentFolder[]>([])
  const [lectures, setLectures] = useState<LectureSummary[]>([])
  const [syllabus, setSyllabus] = useState<DocumentDetail | null>(null)
  const [aiWorking, setAiWorking] = useState(false)
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null)
  const [aiDownloadProgress, setAiDownloadProgress] = useState<number | null>(null)
  const [aiConsentOpen, setAiConsentOpen] = useState(false)
  const [trashedDocuments, setTrashedDocuments] = useState<DocumentSummary[]>([])
  const [sets, setSets] = useState<FlashcardSetSummary[]>([])
  const [trashedSets, setTrashedSets] = useState<FlashcardSetSummary[]>([])
  const [allCards, setAllCards] = useState<Flashcard[]>([])
  const [archivedSemesters, setArchivedSemesters] = useState<Semester[]>([])
  const [archivedClasses, setArchivedClasses] = useState<CourseClass[]>([])
  const [recentDocuments, setRecentDocuments] = useState<DocumentSummary[]>([])
  const [activeDocument, setActiveDocument] = useState<DocumentDetail | null>(null)
  const [activeLecture, setActiveLecture] = useState<LectureDetail | null>(null)
  const [activeSet, setActiveSet] = useState<FlashcardSetDetail | null>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const [commandOpen, setCommandOpen] = useState(false)
  const [globalFindOpen, setGlobalFindOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [toast, setToast] = useState<Toast>(null)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const pendingDocument = useRef<DocumentDetail | null>(null)
  const saveTimer = useRef<number | null>(null)
  const pendingLecture = useRef<LectureDetail | null>(null)
  const lectureSaveTimer = useRef<number | null>(null)
  const [lectureToDelete, setLectureToDelete] = useState<LectureDetail | null>(null)
  const [walkthroughOpen, setWalkthroughOpen] = useState(false)
  const closing = useRef(false)
  const aiConsentResolver = useRef<((proceed: boolean) => void) | null>(null)

  const showToast = useCallback((message: string, type: ToastKind = 'success') => {
    setToast({ message, type })
    window.setTimeout(() => setToast((current) => current?.message === message ? null : current), 3600)
  }, [])
  const loadLibrary = useCallback(async () => {
    try {
      const securityStatus = await api.getSecurityStatus()
      setSecurity(securityStatus)
      if (securityStatus.locked) return
      const [data, recent] = await Promise.all([api.bootstrap(), api.listRecentDocuments()])
      setLibrary(data)
      setRecentDocuments(recent)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'SoFlo could not open its local library.', 'error')
    } finally { setBooting(false) }
  }, [showToast])
  const loadClassContent = useCallback(async (classId: string) => {
    try {
      const [nextDocuments, nextFolders, nextLectures, nextSets, nextCards] = await Promise.all([api.listDocuments(classId), api.listDocumentFolders(classId), api.listLectures(classId), api.listSets(classId), api.listAllCards(classId)])
      setDocuments(nextDocuments)
      setDocumentFolders(nextFolders)
      setLectures(nextLectures)
      setSets(nextSets)
      setAllCards(nextCards)
    } catch (error) { showToast(error instanceof Error ? error.message : 'Class materials could not be loaded.', 'error') }
  }, [showToast])
  useEffect(() => { void loadLibrary() }, [loadLibrary])
  useEffect(() => {
    const settings = library?.settings
    if (settings?.onboardingCompleted && !settings.walkthroughCompleted && !settings.walkthroughSkipped && Boolean(settings.walkthroughStep)) setWalkthroughOpen(true)
  }, [library?.settings])
  useEffect(() => { let unlisten: (() => void) | undefined; void listen<number>('ai-download-progress', (event) => setAiDownloadProgress(event.payload)).then((dispose) => { unlisten = dispose }); return () => unlisten?.() }, [])
  useEffect(() => { let unlisten: (() => void) | undefined; void listen('ai-download-finished', () => setAiDownloadProgress(null)).then((dispose) => { unlisten = dispose }); return () => unlisten?.() }, [])
  useEffect(() => { let unlisten: (() => void) | undefined; void listen<AiProgress>('ai-generation-progress', (event) => setAiProgress(event.payload)).then((dispose) => { unlisten = dispose }); return () => unlisten?.() }, [])
  const classId = view.kind === 'class' || view.kind === 'document' || view.kind === 'lecture' || view.kind === 'flashcardSet' || view.kind === 'study' ? view.classId : null
  useEffect(() => { if (classId) void loadClassContent(classId) }, [classId, loadClassContent])
  useEffect(() => {
    if (view.kind !== 'class' || view.tab !== 'syllabus') return
    setSyllabus(null)
    void api.getSyllabus(view.classId).then(setSyllabus).catch(() => showToast('The syllabus could not be loaded.', 'error'))
  }, [showToast, view])
  useEffect(() => {
    if (view.kind !== 'class' || view.tab !== 'trash') return
    void Promise.all([api.listDocuments(view.classId, true), api.listSets(view.classId, true)]).then(([allDocuments, allSets]) => {
      setTrashedDocuments(allDocuments.filter((document) => document.deletedAt))
      setTrashedSets(allSets.filter((set) => set.deletedAt))
    }).catch(() => showToast('Trash could not be loaded.', 'error'))
  }, [showToast, view])
  useEffect(() => { if (view.kind === 'archive') void Promise.all([api.listSemesters(true), api.listClasses(true)]).then(([semesters, classes]) => { setArchivedSemesters(semesters); setArchivedClasses(classes) }).catch(() => showToast('Archive could not be loaded.', 'error')) }, [showToast, view.kind])
  useEffect(() => {
    if (view.kind === 'document') { setActiveDocument(null); void api.getDocument(view.documentId).then(setActiveDocument).catch(() => showToast('That paper could not be opened.', 'error')) }
    if (view.kind === 'lecture') { setActiveLecture(null); void api.getLecture(view.lectureId).then(setActiveLecture).catch(() => showToast('That lecture could not be opened.', 'error')) }
    if (view.kind === 'flashcardSet' || view.kind === 'study') { setActiveSet(null); void api.getSet(view.setId).then(setActiveSet).catch(() => showToast('That flashcard set could not be opened.', 'error')) }
  }, [showToast, view])

  const flushDocument = useCallback(async () => {
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null }
    const documentToSave = pendingDocument.current
    if (!documentToSave) return
    pendingDocument.current = null
    setSaveState('saving')
    try {
      const saved = await api.saveDocument(documentToSave)
      setActiveDocument((current) => current?.id === saved.id ? { ...current, updatedAt: saved.updatedAt, revision: saved.revision } : current)
      setSaveState('saved')
      void api.listRecentDocuments().then(setRecentDocuments)
      if (classId) void loadClassContent(classId)
    } catch { setSaveState('error'); pendingDocument.current = documentToSave }
  }, [classId, loadClassContent])
  const scheduleDocumentSave = useCallback((next: DocumentDetail) => {
    pendingDocument.current = next
    setSaveState('saving')
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { void flushDocument() }, 550)
  }, [flushDocument])
  const flushLecture = useCallback(async () => {
    if (lectureSaveTimer.current !== null) { window.clearTimeout(lectureSaveTimer.current); lectureSaveTimer.current = null }
    const lectureToSave = pendingLecture.current
    if (!lectureToSave) return
    pendingLecture.current = null
    setSaveState('saving')
    try {
      const saved = await api.saveLecture(lectureToSave)
      setActiveLecture((current) => current?.id === saved.id ? { ...current, updatedAt: saved.updatedAt, revision: saved.revision } : current)
      setSaveState('saved')
      void loadClassContent(lectureToSave.classId)
    } catch { setSaveState('error'); pendingLecture.current = lectureToSave }
  }, [loadClassContent])
  const scheduleLectureSave = useCallback((next: LectureDetail) => {
    pendingLecture.current = next
    setSaveState('saving')
    if (lectureSaveTimer.current !== null) window.clearTimeout(lectureSaveTimer.current)
    lectureSaveTimer.current = window.setTimeout(() => { void flushLecture() }, 550)
  }, [flushLecture])
  useEffect(() => () => { void flushDocument(); void flushLecture() }, [flushDocument, flushLecture])
  const closeSafely = useCallback(async () => {
    if (closing.current) return
    closing.current = true
    try {
      await flushDocument()
      await flushLecture()
      await api.syncEncryptedLibrary()
    } catch {
      // A locked library has no in-memory work to flush; the window may still close.
    }
    await invoke('force_close_window')
  }, [flushDocument, flushLecture])
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void getCurrentWindow().onCloseRequested(async (event) => {
      if (closing.current) return
      event.preventDefault()
      await closeSafely()
    }).then((dispose) => { unlisten = dispose })
    return () => unlisten?.()
  }, [closeSafely])
  useEffect(() => {
    const requestClose = () => { void closeSafely() }
    window.addEventListener('soflo:request-close', requestClose)
    return () => window.removeEventListener('soflo:request-close', requestClose)
  }, [closeSafely])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopImmediatePropagation(); setGlobalFindOpen(true); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(true) }
      if ((event.ctrlKey || event.metaKey) && event.key === '\\') { event.preventDefault(); setSidebarCollapsed((current) => !current) }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [])
  useEffect(() => { const openFind = () => setGlobalFindOpen(true); window.addEventListener('soflo:open-find', openFind); return () => window.removeEventListener('soflo:open-find', openFind) }, [])

  const navigate = (next: AppView) => { void flushDocument(); void flushLecture(); setView(next) }
  const getCourse = (id: string) => library?.classes.find((course) => course.id === id)
  const activeCourse = classId ? getCourse(classId) : undefined
  const createSemester = async (input: { name: string; term: string; year: number }) => {
    await api.createSemester(input); setModal(null); await loadLibrary(); showToast('Semester created.')
  }
  const createClass = async (input: { semesterId: string; name: string; courseCode: string; professor?: string; location?: string; schedule?: string; accentColor?: string }) => {
    const course = await api.createClass(input); setModal(null); await loadLibrary(); navigate({ kind: 'class', classId: course.id, tab: 'overview' }); showToast('Class created.')
  }
  const openNewClass = (semesterId?: string) => { if (!library?.semesters.length) { setModal({ type: 'semester' }); showToast('Create a semester before adding a class.', 'error'); return } setModal({ type: 'class', semesterId }) }
  const createDocument = async () => {
    if (!classId) { showToast('Open a class before creating a paper.', 'error'); return }
    try { const document = await api.createDocument({ classId, title: 'Untitled paper' }); await loadClassContent(classId); navigate({ kind: 'document', classId, documentId: document.id }) } catch { showToast('A new paper could not be created.', 'error') }
  }
  const createLecture = async () => {
    if (!activeCourse) { showToast('Open a class before creating a lecture.', 'error'); return }
    const now = new Date()
    const date = localDateKey(now)
    const meeting = todayMeeting(activeCourse.schedule)
    const label = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' }).format(now)
    try {
      const lecture = await api.createLecture({
        classId: activeCourse.id,
        courseCode: activeCourse.courseCode,
        courseName: activeCourse.name,
        lectureDate: date,
        scheduledStart: meeting.start,
        scheduledEnd: meeting.end,
        professorSnapshot: activeCourse.professor,
        title: `Lecture — ${label}`,
      })
      await loadClassContent(activeCourse.id)
      navigate({ kind: 'lecture', classId: activeCourse.id, lectureId: lecture.id })
    } catch (error) { showToast(error instanceof Error ? error.message : 'A new lecture could not be created.', 'error') }
  }
  const requestAiConsent = () => new Promise<boolean>((resolve) => { aiConsentResolver.current = resolve; setAiConsentOpen(true) })
  const closeAiConsent = (proceed: boolean) => { setAiConsentOpen(false); aiConsentResolver.current?.(proceed); aiConsentResolver.current = null }
  const ensureAiModel = async () => {
    if (!library?.settings.aiEnabled) return ''
    if (library.settings.aiModelPath) return library.settings.aiModelPath
    if (!await requestAiConsent()) throw new Error('AI import was cancelled.')
    setAiDownloadProgress(0)
    try {
      const aiModelPath = await api.downloadDefaultAiModel()
      const settings = { ...library.settings, aiModelPath }
      await api.updateSettings(settings)
      setLibrary((current) => current ? { ...current, settings } : current)
      return aiModelPath
    } finally { setAiDownloadProgress(null) }
  }
  const formatImportedText = async (text: string, source: string) => {
    const aiModelPath = await ensureAiModel()
    if (!aiModelPath) return importPdfAsEditableNote(text, source)
    setAiWorking(true)
    setAiProgress({ progress: 3, message: 'Preparing your document' })
    try { return importAiFormattedNote(await api.refineDocumentText(aiModelPath, text), source) } finally { setAiWorking(false); setAiProgress(null) }
  }
  const importPdfAsNewNote = async () => {
    if (!classId) { showToast('Open a class before importing a PDF.', 'error'); return }
    const source = await open({ title: 'Import document as a new paper', multiple: false, directory: false, filters: [{ name: 'Documents', extensions: ['pdf', 'docx'] }] })
    if (!source || Array.isArray(source)) return
    try {
      const text = source.toLowerCase().endsWith('.docx') ? await api.importWordText(source) : await api.importPdfText(source)
      const imported = await formatImportedText(text, source)
      const created = await api.createDocument({ classId, title: imported.title })
      const saved = await api.saveDocument({ id: created.id, title: imported.title, content: JSON.stringify(imported.document), contentPlain: imported.plainText, isFavorite: created.isFavorite })
      await loadClassContent(classId)
      navigate({ kind: 'document', classId, documentId: saved.id })
      showToast('Document imported as an editable paper.')
    } catch (error) { showToast(error instanceof Error ? error.message : 'That document could not be imported.', 'error') }
  }
  const importSyllabus = async () => {
    if (!classId) { showToast('Open a class before importing a syllabus.', 'error'); return }
    const source = await open({ title: 'Import class syllabus', multiple: false, directory: false, filters: [{ name: 'Documents', extensions: ['pdf', 'docx'] }] })
    if (!source || Array.isArray(source)) return
    try {
      const text = source.toLowerCase().endsWith('.docx') ? await api.importWordText(source) : await api.importPdfText(source)
      const imported = await formatImportedText(text, source)
      if (syllabus) await api.setDocumentDeleted(syllabus.id, true)
      const created = await api.createDocument({ classId, title: imported.title || 'Class syllabus' })
      await api.saveDocument({ id: created.id, title: imported.title || 'Class syllabus', content: JSON.stringify(imported.document), contentPlain: imported.plainText, isFavorite: false })
      const saved = await api.setDocumentSyllabus(created.id)
      setSyllabus(saved)
      await loadClassContent(classId)
      showToast('Syllabus imported as a read-only paper.')
    } catch (error) { showToast(error instanceof Error ? error.message : 'That syllabus could not be imported.', 'error') }
  }
  const createSet = async () => {
    if (!classId) { showToast('Open a class before creating a flashcard set.', 'error'); return }
    try { const set = await api.createSet({ classId, title: 'Untitled set' }); await loadClassContent(classId); navigate({ kind: 'flashcardSet', classId, setId: set.id }) } catch { showToast('A new flashcard set could not be created.', 'error') }
  }
  const importSet = async (targetClassId: string, title: string, text: string) => {
    const rows = text.split(/\r?\n/).map((line) => line.split('\t')).filter(([front, back]) => front?.trim() && back?.trim())
    if (!rows.length) throw new Error('Add one tab-separated term and definition per line.')
    const created = await api.createSet({ classId: targetClassId, title: title.trim() || 'Imported flashcards', description: 'Imported flashcards.' })
    await Promise.all(rows.map(([front, back], position) => api.saveCard({ setId: created.id, front: front.trim(), back: back.trim(), position, isStarred: false })))
    await loadClassContent(targetClassId)
    setModal(null)
    navigate({ kind: 'flashcardSet', classId: targetClassId, setId: created.id })
    showToast(`${rows.length} flashcards imported.`)
  }
  const generateAiSet = async (targetClassId: string, request: AiSetRequest) => {
    try {
      const imported = await Promise.all(request.sources.map((source) => source.toLowerCase().endsWith('.docx') ? api.importWordText(source) : api.importPdfText(source)))
      const manual = request.pasted.trim()
      const textOnly = !request.sources.length && Boolean(manual)
      const materials = [request.topic.trim() && `TOPIC OR PROMPT:\n${request.topic.trim()}`, manual && `${textOnly ? 'TEXT OR TOPIC' : 'PASTED MATERIAL'}:\n${manual}`, ...imported.map((text, index) => `UPLOADED MATERIAL ${index + 1}:\n${text}`)].filter(Boolean).join('\n\n--- NEXT SOURCE ---\n\n')
      if (!materials.trim()) throw new Error('Add a file, paste study material, or describe a topic first.')
      const modelPath = await ensureAiModel()
      if (!modelPath) throw new Error('Turn on AI in Settings to create cards with AI.')
      setAiWorking(true); setAiProgress({ progress: 3, message: 'Preparing your study materials' })
      const countInstruction = request.cardCount === 'auto' ? 'Choose an appropriate number of cards.' : `Make about ${request.cardCount} cards.`
      const raw = await api.generateFlashcardsText(modelPath, materials, `${countInstruction} Use ${request.depth} depth. ${request.guidance.trim()}`)
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const start = cleaned.indexOf('[')
      const end = cleaned.lastIndexOf(']')
      if (start < 0 || end <= start) throw new Error('SoFlo could not read the flashcards the local model returned. Try a shorter prompt or add a little more context.')
      let generated: { front?: string; back?: string }[]
      try { generated = JSON.parse(cleaned.slice(start, end + 1)) as { front?: string; back?: string }[] } catch { throw new Error('SoFlo could not read the flashcards the local model returned. Try again with a little more context.') }
      const cards = generated.filter((card) => card.front?.trim() && card.back?.trim()).slice(0, request.cardCount === 'auto' ? 40 : request.cardCount)
      if (!cards.length) throw new Error('The local AI model did not return usable flashcards.')
      const sourceKinds = [request.sources.length && 'uploaded material', request.pasted.trim() && 'pasted material', request.topic.trim() && 'a topic prompt'].filter(Boolean).join(', ')
      const set = await api.createSet({ classId: targetClassId, title: request.title.trim() || 'AI study set', description: `Created from ${sourceKinds || 'study material'}.` })
      await Promise.all(cards.map((card, position) => api.saveCard({ setId: set.id, front: card.front!.trim(), back: card.back!.trim(), notes: `AI-generated from ${sourceKinds || 'study material'}.`, position, isStarred: false })))
      await loadClassContent(targetClassId); setModal(null); navigate({ kind: 'flashcardSet', classId: targetClassId, setId: set.id }); showToast(`${cards.length} flashcards created.`)
    } catch (error) { console.error('SoFlo AI flashcard generation failed.', error); showToast(aiFailureMessage(error), 'error') } finally { setAiWorking(false); setAiProgress(null) }
  }
  const updateDocument = (partial: Partial<Pick<DocumentDetail, 'content' | 'contentPlain' | 'title'>>) => {
    setActiveDocument((current) => { if (!current) return current; const next = { ...current, ...partial }; scheduleDocumentSave(next); return next })
  }
  const updateLecture = (partial: Partial<Pick<LectureDetail, 'content' | 'contentPlain' | 'title'>>) => {
    setActiveLecture((current) => { if (!current) return current; const next = { ...current, ...partial }; scheduleLectureSave(next); return next })
  }
  const archiveActiveClass = async () => {
    if (!activeCourse) return
    await api.updateClass({ ...activeCourse, archived: true })
    await loadLibrary(); navigate({ kind: 'home' }); showToast(`${activeCourse.name} has been archived.`)
  }
  const restoreClass = async (course: CourseClass) => { await api.updateClass({ ...course, archived: false }); await loadLibrary(); setArchivedClasses((current) => current.filter((item) => item.id !== course.id)); showToast(`${course.name} has been restored.`) }
  const deleteDocument = async () => { if (!activeDocument) return; await flushDocument(); await api.setDocumentDeleted(activeDocument.id, true); await loadClassContent(activeDocument.classId); navigate({ kind: 'class', classId: activeDocument.classId, tab: 'notes' }); showToast('Paper moved to trash.') }
  const deleteLecture = async (lecture: Pick<LectureDetail, 'id' | 'classId' | 'title'>) => {
    if (activeLecture?.id === lecture.id) await flushLecture()
    try {
      await api.deleteLecture(lecture.id)
      await loadClassContent(lecture.classId)
      setLectureToDelete(null)
      if (view.kind === 'lecture' && view.lectureId === lecture.id) navigate({ kind: 'class', classId: lecture.classId, tab: 'lectures' })
      showToast('Lecture permanently deleted.')
    } catch (error) { showToast(error instanceof Error ? error.message : 'That lecture could not be deleted.', 'error') }
  }
  const duplicateDocument = async () => { if (!activeDocument) return; await flushDocument(); const duplicate = await api.duplicateDocument(activeDocument.id); navigate({ kind: 'document', classId: duplicate.classId, documentId: duplicate.id }); showToast('Paper duplicated.') }
  const trashPaper = async (paper: DocumentSummary) => { await api.setDocumentDeleted(paper.id, true); await loadClassContent(paper.classId); showToast('Paper moved to trash.') }
  const duplicatePaper = async (paper: DocumentSummary, title: string) => { const duplicate = await api.duplicateDocument(paper.id, title); await loadClassContent(paper.classId); navigate({ kind: 'document', classId: duplicate.classId, documentId: duplicate.id }); showToast('Paper duplicated.') }
  const bulkRenamePapers = async (papers: { id: string; title: string }[]) => { if (!classId) return; await api.renameDocuments(papers); await loadClassContent(classId); showToast(`${papers.length} ${papers.length === 1 ? 'paper' : 'papers'} renamed.`) }
  const groupPapers = async (id: string, targetId: string) => { if (!classId) return; await api.groupDocuments(id, targetId); await loadClassContent(classId); showToast('Papers grouped.') }
  const ungroupPaper = async (id: string) => { if (!classId) return; await api.removeDocumentFromFolder(id); await loadClassContent(classId); showToast('Paper removed from group.') }
  const deleteSet = async () => { if (!activeSet) return; await api.setSetDeleted(activeSet.id, true); await loadClassContent(activeSet.classId); navigate({ kind: 'class', classId: activeSet.classId, tab: 'flashcards' }); showToast('Flashcard set moved to trash.') }
  const trashSet = async (set: FlashcardSetSummary) => { await api.setSetDeleted(set.id, true); await loadClassContent(set.classId); showToast('Flashcard set moved to trash.') }
  const duplicateSet = async (set: FlashcardSetSummary, title: string) => { const copy = await api.duplicateSet(set.id, title); await loadClassContent(set.classId); navigate({ kind: 'flashcardSet', classId: copy.classId, setId: copy.id }); showToast('Flashcard set duplicated.') }
  const restoreDocument = async (id: string) => { if (!classId) return; await api.setDocumentDeleted(id, false); await loadClassContent(classId); setTrashedDocuments((current) => current.filter((document) => document.id !== id)); showToast('Paper restored.') }
  const restoreSet = async (id: string) => { if (!classId) return; await api.setSetDeleted(id, false); await loadClassContent(classId); setTrashedSets((current) => current.filter((set) => set.id !== id)); showToast('Flashcard set restored.') }
  const setSettings = (settings: AppSettings) => setLibrary((current) => current ? { ...current, settings } : current)
  const completeOnboarding = async (input: { name: string; themeColor: AppSettings['themeColor']; pin?: string; password?: string; path: 'guided' | 'explore' }) => {
    if (!library) return
    const settings = { ...library.settings, userName: input.name, themeColor: input.themeColor, onboardingCompleted: true, walkthroughCompleted: false, walkthroughSkipped: input.path === 'explore', walkthroughStep: input.path === 'guided' ? 'library' : '', walkthroughExampleClassId: '', walkthroughExampleSemesterId: '' }
    try {
      await api.updateSettings(settings)
      if (input.pin || input.password) setSecurity(await api.updateLibrarySecurity({ newPin: input.pin, newPassword: input.password, removePin: false, removePassword: false }))
      setSettings(settings)
      setView({ kind: 'home' })
      setWalkthroughOpen(input.path === 'guided')
    } catch (error) { showToast(error instanceof Error ? error.message : 'Your setup could not be saved.', 'error') }
  }
  const startWalkthrough = async (replaceExisting = false) => {
    if (!library) return
    const { walkthroughExampleClassId, walkthroughExampleSemesterId } = library.settings
    const settings = { ...library.settings, walkthroughCompleted: false, walkthroughSkipped: false, walkthroughStep: 'library', walkthroughExampleClassId: '', walkthroughExampleSemesterId: '' }
    setSettings(settings)
    try {
      if (replaceExisting && walkthroughExampleClassId) await api.deleteClass(walkthroughExampleClassId)
      if (replaceExisting && walkthroughExampleSemesterId) await api.deleteSemester(walkthroughExampleSemesterId)
      await api.updateSettings(settings)
      setModal(null)
      await loadLibrary()
      setView({ kind: 'home' })
      setWalkthroughOpen(true)
    } catch { setSettings(library.settings); showToast('The walkthrough could not be started.', 'error') }
  }
  const saveWalkthroughStep = async (step: string) => {
    if (!library) return
    const settings = { ...library.settings, walkthroughCompleted: false, walkthroughSkipped: false, walkthroughStep: step }
    setSettings(settings)
    try { await api.updateSettings(settings) } catch { showToast('Walkthrough progress could not be saved.', 'error') }
  }
  const ensureWalkthroughClass = async () => {
    if (!library) return null
    const existing = library.settings.walkthroughExampleClassId && library.classes.find((course) => course.id === library.settings.walkthroughExampleClassId)
    if (existing) { navigate({ kind: 'class', classId: existing.id, tab: 'overview' }); return existing.id }
    try {
      let semesterId = library.semesters[0]?.id
      let createdSemesterId = ''
      if (!semesterId) {
        const year = new Date().getFullYear()
        const semester = await api.createSemester({ name: 'SoFlo walkthrough', term: 'Walkthrough', year })
        semesterId = semester.id
        createdSemesterId = semester.id
      }
      const course = await api.createClass({ semesterId, name: 'Introduction to Computer Science', courseCode: 'CS 101', professor: 'Professor Jordan', location: 'Science 204', schedule: 'Mon 09:00 AM-10:00 AM; Wed 09:00 AM-10:00 AM', accentColor: '#5AA6E6' })
      const settings = { ...library.settings, walkthroughExampleClassId: course.id, walkthroughExampleSemesterId: createdSemesterId }
      await api.updateSettings(settings)
      setSettings(settings)
      await loadLibrary()
      navigate({ kind: 'class', classId: course.id, tab: 'overview' })
      showToast('Example class created.')
      return course.id
    } catch (error) { showToast(error instanceof Error ? error.message : 'The example class could not be created.', 'error'); return null }
  }
  const buildWalkthroughBasics = async () => {
    if (!activeSet) return false
    try {
      await api.setSetDeleted(activeSet.id, true)
      const set = await api.createSet({ classId: activeSet.classId, title: 'Everyday basics', description: 'Three small cards for the SoFlo walkthrough.' })
      const cards = [
        ['What color is grass?', 'Green'],
        ['What is the largest animal?', 'The blue whale'],
        ['What planet do we live on?', 'Earth'],
      ]
      await Promise.all(cards.map(([front, back], position) => api.saveCard({ setId: set.id, front, back, position, isStarred: false })))
      await loadClassContent(activeSet.classId)
      navigate({ kind: 'flashcardSet', classId: activeSet.classId, setId: set.id })
      return true
    } catch (error) { showToast(error instanceof Error ? error.message : 'The walkthrough flashcards could not be prepared.', 'error'); return false }
  }
  const startWalkthroughFlashcards = () => { if (activeSet) navigate({ kind: 'study', classId: activeSet.classId, setId: activeSet.id, mode: 'flashcards' }) }
  const openWalkthroughFlashcardSets = () => { if (activeLecture) navigate({ kind: 'class', classId: activeLecture.classId, tab: 'flashcards' }) }
  const removeWalkthroughExample = async () => {
    if (!library) return false
    const { walkthroughExampleClassId, walkthroughExampleSemesterId } = library.settings
    try {
      if (walkthroughExampleClassId) await api.deleteClass(walkthroughExampleClassId)
      if (walkthroughExampleSemesterId) await api.deleteSemester(walkthroughExampleSemesterId)
      const settings = { ...library.settings, walkthroughExampleClassId: '', walkthroughExampleSemesterId: '' }
      await api.updateSettings(settings)
      setSettings(settings)
      await loadLibrary()
      navigate({ kind: 'home' })
      showToast('Example walkthrough material removed.')
      return true
    } catch (error) { showToast(error instanceof Error ? error.message : 'The example walkthrough material could not be removed.', 'error'); return false }
  }
  const finishWalkthrough = async (skipped: boolean) => {
    if (!library) return
    const settings = { ...library.settings, walkthroughCompleted: !skipped, walkthroughSkipped: skipped, walkthroughStep: '' }
    setSettings(settings); setWalkthroughOpen(false)
    try { await api.updateSettings(settings) } catch { showToast('Walkthrough progress could not be saved.', 'error') }
  }
  const unlockLibrary = async (input: { pin?: string; password?: string }) => {
    const status = await api.unlockLibrary(input)
    setSecurity(status)
    setBooting(true)
    await loadLibrary()
  }
  const activeLectureAsDocument: DocumentDetail | null = activeLecture ? {
    ...activeLecture,
    excerpt: activeLecture.contentPlain,
    isFavorite: false,
    deletedAt: null,
    isSyllabus: false,
    folderId: null,
    linkedPdfPath: null,
  } : null

  if (booting) return <div className="boot-screen"><img className="brand-mark" src={sofloMark} alt="" /><strong>SoFlo</strong><i /></div>
  if (security?.locked) return <LockView security={security} onUnlock={unlockLibrary} />
  if (!library) return <div className="boot-screen"><img className="brand-mark" src={sofloMark} alt="" /><strong>SoFlo</strong><i /></div>
  return <div className={`app theme-${library.settings.themeColor} ${library.settings.reduceMotion ? 'reduce-motion' : ''}`}>
    <TitleBar />
    <div className="app-body"><Sidebar semesters={library.semesters} classes={library.classes} activeView={view} collapsed={sidebarCollapsed} onNavigate={navigate} onNewSemester={() => setModal({ type: 'semester' })} onNewClass={openNewClass} onOpenCommand={() => setCommandOpen(true)} />
      <section className="app-content"><button className="sidebar-toggle" aria-label="Toggle sidebar" onClick={() => setSidebarCollapsed((current) => !current)}>{sidebarCollapsed ? <Plus size={17} /> : <Menu size={17} />}</button>
        {view.kind === 'home' && <HomeView semesters={library.semesters} classes={library.classes} recentDocuments={recentDocuments} userName={library.settings.userName} onNewSemester={() => setModal({ type: 'semester' })} onNewClass={() => openNewClass()} onOpenClass={(targetClassId) => navigate({ kind: 'class', classId: targetClassId, tab: 'overview' })} onOpenDocument={(document) => navigate({ kind: 'document', classId: document.classId, documentId: document.id })} />}
        {view.kind === 'calendar' && <CalendarView classes={library.classes} />}
        {view.kind === 'settings' && <SettingsView settings={library.settings} dataLocation={library.dataLocation} security={security} onSettingsChange={setSettings} onSecurityChange={setSecurity} onToast={showToast} onStartWalkthrough={() => library.settings.walkthroughExampleClassId ? setModal({ type: 'restartWalkthrough' }) : void startWalkthrough()} />}
        {view.kind === 'help' && <HelpView />}
        {view.kind === 'archive' && <ArchiveView semesters={archivedSemesters} classes={archivedClasses} onRestore={(course) => void restoreClass(course)} />}
        {view.kind === 'class' && activeCourse && <ClassView course={activeCourse} tab={view.tab} documentCount={documents.length} documents={documents} folders={documentFolders} lectures={lectures} syllabus={syllabus} aiEnabled={Boolean(library.settings.aiEnabled)} trashedDocuments={trashedDocuments} sets={sets} trashedSets={trashedSets} allCards={allCards} onTab={(tab) => navigate({ kind: 'class', classId: activeCourse.id, tab })} onNewDocument={() => void createDocument()} onNewLecture={() => void createLecture()} onImportPdf={() => void importPdfAsNewNote()} onImportSyllabus={() => void importSyllabus()} onNewSet={() => void createSet()} onImportSet={() => setModal({ type: 'importSet', classId: activeCourse.id })} onNewAiSet={() => setModal({ type: 'aiSet', classId: activeCourse.id })} onOpenDocument={(document) => navigate({ kind: 'document', classId: activeCourse.id, documentId: document.id })} onOpenLecture={(lecture) => navigate({ kind: 'lecture', classId: activeCourse.id, lectureId: lecture.id })} onDeleteLecture={(lecture) => void deleteLecture(lecture)} onTrashDocument={(document) => void trashPaper(document)} onDuplicateDocument={(document, title) => void duplicatePaper(document, title)} onBulkRename={(papers) => void bulkRenamePapers(papers)} onGroupDocuments={(id, targetId) => void groupPapers(id, targetId)} onUngroupDocument={(id) => void ungroupPaper(id)} onOpenSet={(setId) => navigate({ kind: 'flashcardSet', classId: activeCourse.id, setId })} onStudyWeak={(setId, cardIds) => navigate({ kind: 'study', classId: activeCourse.id, setId, mode: 'learn', cardIds })} onDuplicateSet={(set, title) => void duplicateSet(set, title)} onTrashSet={(set) => void trashSet(set)} onRestoreDocument={(id) => void restoreDocument(id)} onRestoreSet={(id) => void restoreSet(id)} onArchive={() => void archiveActiveClass()} />}
        {view.kind === 'document' && (activeDocument ? <DocumentEditor document={activeDocument} spellcheck={library.settings.spellcheck} fontSize={library.settings.editorFontSize} readingSurface={library.settings.editorCanvas} saveState={saveState} onChange={(content, contentPlain, title) => updateDocument({ content, contentPlain, title })} onBack={() => navigate({ kind: 'class', classId: activeDocument.classId, tab: 'notes' })} onDelete={() => void deleteDocument()} onDuplicate={() => void duplicateDocument()} /> : <LoadingView />)}
        {view.kind === 'lecture' && (activeLecture && activeLectureAsDocument ? <DocumentEditor document={activeLectureAsDocument} spellcheck={library.settings.spellcheck} fontSize={library.settings.editorFontSize} readingSurface={library.settings.editorCanvas} saveState={saveState} collectionLabel="Lectures" deleteLabel="Delete lecture" deriveTitle={false} context={`${activeLecture.courseCode || activeLecture.courseName} · ${activeLecture.lectureDate}${activeLecture.scheduledStart ? ` · ${activeLecture.scheduledStart}${activeLecture.scheduledEnd ? `–${activeLecture.scheduledEnd}` : ''}` : ''}${activeLecture.professorSnapshot ? ` · ${activeLecture.professorSnapshot}` : ''}`} onChange={(content, contentPlain, title) => updateLecture({ content, contentPlain, title })} onBack={() => navigate({ kind: 'class', classId: activeLecture.classId, tab: 'lectures' })} onDelete={() => setLectureToDelete(activeLecture)} /> : <LoadingView />)}
        {view.kind === 'flashcardSet' && (activeSet ? <FlashcardSetEditor set={activeSet} onBack={() => navigate({ kind: 'class', classId: activeSet.classId, tab: 'flashcards' })} onStudy={(mode) => navigate({ kind: 'study', classId: activeSet.classId, setId: activeSet.id, mode })} onUpdated={(set) => { setActiveSet(set); void loadClassContent(set.classId) }} onDelete={() => void deleteSet()} onToast={showToast} /> : <LoadingView />)}
        {view.kind === 'study' && (activeSet ? <StudyView set={activeSet} mode={view.mode} cardIds={view.cardIds} onBack={() => { void api.getSet(activeSet.id).then(setActiveSet); navigate({ kind: 'flashcardSet', classId: activeSet.classId, setId: activeSet.id }) }} onModeChange={(mode) => navigate({ kind: 'study', classId: activeSet.classId, setId: activeSet.id, mode, cardIds: view.cardIds })} /> : <LoadingView />)}
      </section>
    </div>
    <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} classes={library.classes} onNavigate={navigate} onNewNote={() => void createDocument()} onNewSet={() => void createSet()} />
    <GlobalFind open={globalFindOpen} onClose={() => setGlobalFindOpen(false)} />
    {modal?.type === 'semester' && <CreateSemesterDialog onClose={() => setModal(null)} onCreate={createSemester} />}
    {modal?.type === 'class' && <CreateClassDialog semesters={library.semesters} initialSemesterId={modal.semesterId} onClose={() => setModal(null)} onCreate={createClass} />}
    {modal?.type === 'importSet' && <ImportSetDialog onClose={() => setModal(null)} onImport={(title, text) => importSet(modal.classId, title, text)} />}
    {modal?.type === 'aiSet' && <AiSetDialog onClose={() => setModal(null)} onCreate={(request) => void generateAiSet(modal.classId, request)} />}
    {modal?.type === 'restartWalkthrough' && <div className="paper-dialog-backdrop" role="presentation"><section className="paper-dialog" role="dialog" aria-modal="true" aria-label="Restart walkthrough"><header><div><p className="eyebrow">RESTART WALKTHROUGH</p><h2>Replace the old example class?</h2></div><button className="icon-button" onClick={() => setModal(null)} aria-label="Close"><X size={17} /></button></header><div className="paper-dialog-content"><p>You kept the example class from the last walkthrough. Starting again will permanently remove that example and create a fresh one for this walkthrough. Your own classes and papers will not be changed.</p></div><footer><button className="button button-quiet" onClick={() => setModal(null)}>Cancel</button><button className="button button-primary" onClick={() => void startWalkthrough(true)}>Start walkthrough</button></footer></section></div>}
    {lectureToDelete && <div className="paper-dialog-backdrop" role="presentation"><section className="paper-dialog" role="dialog" aria-modal="true" aria-label="Delete lecture"><header><div><p className="eyebrow">PERMANENT ACTION</p><h2>Delete this lecture?</h2></div><button className="icon-button" onClick={() => setLectureToDelete(null)} aria-label="Cancel deletion"><X size={17} /></button></header><div className="paper-dialog-content"><p><strong>{lectureToDelete.title}</strong> and its notes will be permanently deleted. This cannot be undone.</p></div><footer><button className="button button-quiet" onClick={() => setLectureToDelete(null)}>Cancel</button><button className="button button-danger" onClick={() => void deleteLecture(lectureToDelete)}>Delete lecture</button></footer></section></div>}
    {toast && <div className={`toast ${toast.type}`} role="status">{toast.type === 'success' ? <Plus size={15} /> : <X size={15} />}{toast.message}</div>}
    {aiConsentOpen && <div className="ai-consent-backdrop" role="presentation"><section className="ai-consent-card" role="dialog" aria-modal="true" aria-label="Use local AI?"><p className="eyebrow">LOCAL ARTIFICIAL INTELLIGENCE</p><h2>This action will use AI.</h2><p>SoFlo will download its compact local model once, then process this document only on your PC. This is your reminder—turn AI off any time in Settings.</p><div><button className="button button-quiet" onClick={() => closeAiConsent(false)}>Return</button><button className="button button-primary" onClick={() => closeAiConsent(true)}>Proceed</button></div></section></div>}
    {aiDownloadProgress !== null && <div className="ai-consent-backdrop" role="presentation"><section className="ai-consent-card ai-download-card" role="dialog" aria-modal="true" aria-label="Downloading local AI model"><p className="eyebrow">PREPARING LOCAL AI</p><h2>Downloading your private model</h2><p>This happens once. Keep SoFlo open while the model is saved on this PC.</p><div className="ai-download-track"><i style={{ width: `${aiDownloadProgress}%` }} /></div><strong>{aiDownloadProgress}%</strong></section></div>}
    {aiWorking && <div className="ai-consent-backdrop ai-progress-backdrop" role="presentation"><section className="ai-consent-card ai-download-card ai-progress-card" role="status" aria-live="polite"><i className="ai-progress-spinner" /><p className="eyebrow">SOFLO AI IS WORKING</p><h2>Making this editable</h2><p>{aiProgress?.message ?? 'Formatting your document on this PC.'}</p><div className="ai-download-track"><i style={{ width: `${aiProgress?.progress ?? 4}%` }} /></div><strong>{aiProgress?.progress ?? 4}% complete</strong></section></div>}
    {walkthroughOpen && <GuidedWalkthrough initialStep={library.settings.walkthroughStep} hasExample={Boolean(library.settings.walkthroughExampleClassId)} onStep={(step) => void saveWalkthroughStep(step)} onCreateExample={ensureWalkthroughClass} onBuildBasics={buildWalkthroughBasics} onOpenFlashcardSets={openWalkthroughFlashcardSets} onStartFlashcards={startWalkthroughFlashcards} onRemoveExample={removeWalkthroughExample} onFinish={() => void finishWalkthrough(false)} onSkip={() => void finishWalkthrough(true)} />}
    {!library.settings.onboardingCompleted && <WelcomeView onComplete={completeOnboarding} />}
  </div>
}

function LoadingView() { return <div className="content-loading"><i />Loading your material…</div> }

function GlobalFind({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const ranges = useRef<Range[]>([])
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) window.setTimeout(() => input.current?.focus(), 0) }, [open])
  useEffect(() => {
    const css = CSS as unknown as { highlights?: Map<string, unknown> }
    css.highlights?.delete('soflo-find')
    ranges.current = []
    if (!query.trim()) return
    const root = document.querySelector('.app-body')
    if (!root) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement?.closest('.global-find') || !node.nodeValue?.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT })
    const needle = query.toLocaleLowerCase()
    let node: Node | null
    while ((node = walker.nextNode()) && ranges.current.length < 200) { const value = node.nodeValue ?? ''; let start = 0; while ((start = value.toLocaleLowerCase().indexOf(needle, start)) >= 0 && ranges.current.length < 200) { const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + needle.length); ranges.current.push(range); start += needle.length } }
    const HighlightCtor = (window as unknown as { Highlight?: new (...items: Range[]) => unknown }).Highlight
    if (HighlightCtor) css.highlights?.set('soflo-find', new HighlightCtor(...ranges.current))
    setIndex(0)
    return () => { css.highlights?.delete('soflo-find') }
  }, [query])
  useEffect(() => () => { (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete('soflo-find') }, [])
  const next = () => { if (!ranges.current.length) return; const nextIndex = (index + 1) % ranges.current.length; setIndex(nextIndex); const range = ranges.current[nextIndex]; const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); (range.startContainer.parentElement ?? document.body).scrollIntoView({ block: 'center', behavior: 'smooth' }) }
  if (!open) return null
  return <div className="global-find"><Search size={15} /><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); next() } if (event.key === 'Escape') onClose() }} placeholder="Find in SoFlo" /><span>{query ? `${ranges.current.length} matches · Enter for next` : 'Type to highlight'}</span><button className="icon-button tiny" onClick={onClose} aria-label="Close find"><X size={15} /></button></div>
}

function ImportSetDialog({ onClose, onImport }: { onClose: () => void; onImport: (title: string, text: string) => Promise<void> }) {
  const [title, setTitle] = useState('Imported flashcards')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const choose = async () => {
    const source = await open({ title: 'Import flashcards', multiple: false, directory: false, filters: [{ name: 'Text files', extensions: ['txt'] }] })
    if (!source || Array.isArray(source)) return
    try { setText(await api.readTextFile(source)); setError(''); const name = source.split(/[\\/]/).pop()?.replace(/\.txt$/i, '').trim(); if (name && title === 'Imported flashcards') setTitle(name) } catch { setError('That text file could not be opened. You can still paste your cards below.') }
  }
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!text.trim()) return
    setSaving(true)
    try { await onImport(title, text) } finally { setSaving(false) }
  }
  return <div className="paper-dialog-backdrop" role="presentation"><section className="paper-dialog" role="dialog" aria-modal="true" aria-label="Import flashcards"><header><div><p className="eyebrow">FLASHCARDS</p><h2>Import a set</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header><form onSubmit={submit}><div className="paper-dialog-content"><p>Paste one tab-separated term and definition per line, or choose a .txt file exported by SoFlo.</p>{error && <p className="form-hint">{error}</p>}<label>Set name<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Cards<textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} placeholder={'Mitosis\tCell division that produces two identical cells\nMeiosis\tCell division that produces reproductive cells'} /></label></div><footer><button type="button" className="button button-quiet" onClick={() => void choose()}>Choose .txt file</button><span /><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!text.trim() || saving}>{saving ? 'Importing...' : 'Import set'}</button></footer></form></section></div>
}

const walkthroughSteps = [
  { id: 'library', title: 'Start with one class.', copy: 'Classes keep your papers, lectures, flashcards, and study progress in one place.', action: 'Create example class' },
  { id: 'papers', title: 'Make it yours on the page.', copy: 'Open a paper, click anywhere on the page, and type a sentence. Then double-click the top or bottom margin to edit that page’s header or footer.', action: 'Create a paper' },
  { id: 'lectures', title: 'Keep each class meeting together.', copy: 'Lectures are dated notes for a specific class session. They stay next to your papers instead of getting lost in a general notes list.', action: 'Create a lecture' },
  { id: 'study', title: 'Turn material into review.', copy: 'A flashcard set can be studied with Flashcards, Learn, Test, or Match. Your results build the mastery view for that class.', action: 'Create a set' },
  { id: 'finish', title: 'You are ready to explore.', copy: 'The walkthrough data is yours to keep as a reference, or you can remove the example class and continue with a clean library.', action: '' },
] as const

type SpotlightRect = { left: number; top: number; right: number; bottom: number }

function useSpotlightRects(selectors: string[]) {
  const selectorKey = selectors.join('|')
  const [rects, setRects] = useState<SpotlightRect[]>([])
  useEffect(() => {
    const measure = () => {
      const next = selectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element) => {
        const rect = element.getBoundingClientRect()
        return { left: Math.max(8, rect.left - 8), top: Math.max(50, rect.top - 8), right: Math.min(window.innerWidth - 8, rect.right + 8), bottom: Math.min(window.innerHeight - 8, rect.bottom + 8) }
      }).filter((rect) => rect.right > rect.left && rect.bottom > rect.top))
      setRects(next)
    }
    measure()
    const timer = window.setInterval(measure, 180)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { window.clearInterval(timer); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  // The selected selector set is the input; individual callers deliberately recreate it each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectorKey])
  return rects
}

function SpotlightShields({ rects }: { rects: SpotlightRect[] }) {
  if (!rects.length) return <i className="walkthrough-shade walkthrough-shade-full" />
  const union = rects.reduce((all, rect) => ({ left: Math.min(all.left, rect.left), top: Math.min(all.top, rect.top), right: Math.max(all.right, rect.right), bottom: Math.max(all.bottom, rect.bottom) }))
  const styles = [
    { left: 0, top: 0, right: 0, height: union.top },
    { left: 0, top: union.top, width: union.left, bottom: 0 },
    { left: union.right, top: union.top, right: 0, bottom: 0 },
    { left: union.left, top: union.bottom, right: window.innerWidth - union.right, bottom: 0 },
  ]
  return <>{styles.map((style, index) => <i key={index} className="walkthrough-shade" style={style} />)}{rects.map((rect, index) => <i key={`spotlight-${index}`} className="walkthrough-spotlight" style={{ left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }} />)}</>
}

function GuidedWalkthrough({ initialStep, hasExample, onStep, onCreateExample, onBuildBasics, onOpenFlashcardSets, onStartFlashcards, onRemoveExample, onFinish, onSkip }: { initialStep: string; hasExample: boolean; onStep: (step: string) => void; onCreateExample: () => Promise<string | null>; onBuildBasics: () => Promise<boolean>; onOpenFlashcardSets: () => void; onStartFlashcards: () => void; onRemoveExample: () => Promise<boolean>; onFinish: () => void; onSkip: () => void }) {
  const initialIndex = Math.max(0, walkthroughSteps.findIndex((item) => item.id === initialStep))
  const [index, setIndex] = useState(initialIndex)
  const [phase, setPhase] = useState(hasExample ? 'class-explore' : 'class-create')
  const [busy, setBusy] = useState(false)
  const [paperReady, setPaperReady] = useState(false)
  const [cardStep, setCardStep] = useState(0)
  const step = walkthroughSteps[index]
  const move = (next: number) => { const safe = Math.max(0, Math.min(next, walkthroughSteps.length - 1)); setIndex(safe); onStep(walkthroughSteps[safe].id) }
  useEffect(() => {
    const protectedButtons = new Set<HTMLButtonElement>()
    const protectArchive = () => document.querySelectorAll<HTMLButtonElement>('button[aria-label="Archive class"]').forEach((button) => { button.disabled = true; protectedButtons.add(button) })
    protectArchive()
    const timer = window.setInterval(protectArchive, 120)
    return () => { window.clearInterval(timer); protectedButtons.forEach((button) => { button.disabled = false }) }
  }, [])
  useEffect(() => {
    const listen = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      if (index === 3 && phase === 'set-create' && target.closest('.new-set-menu .paper-action-menu button:not(:first-child)')) { event.preventDefault(); event.stopImmediatePropagation(); return }
      if (index === 1 && phase === 'papers-tab' && target.closest('.class-tabs button:nth-child(2)')) setPhase('papers-new')
      else if (index === 1 && phase === 'papers-new' && target.closest('.section-actions .button-primary')) setPhase('paper-write')
      else if (index === 1 && phase === 'paper-back' && target.closest('.editor-breadcrumb-link')) { move(2); setPhase('lectures-tab') }
      else if (index === 2 && phase === 'lectures-tab' && target.closest('.class-tabs button:nth-child(3)')) setPhase('lectures-new')
      else if (index === 2 && phase === 'lectures-new' && target.closest('.lecture-empty .button-primary')) setPhase('lecture-created')
      else if (index === 3 && phase === 'flashcards-tab' && target.closest('.class-tabs button:nth-child(5)')) setPhase('set-new')
      else if (index === 3 && phase === 'set-new' && target.closest('.new-set-menu > .button')) setPhase('set-create')
      else if (index === 3 && phase === 'set-create' && target.closest('.new-set-menu .paper-action-menu button:first-child')) setPhase('set-created')
      else if (index === 3 && phase === 'basic-star' && target.closest('.editable-card:first-child .card-action:not(.delete)')) setPhase('study-start')
      else if (index === 3 && phase === 'card-flip' && target.closest('.flashcard')) setPhase(cardStep === 0 ? 'card-next' : 'card-response')
      else if (index === 3 && phase === 'card-next' && target.closest('.study-footer [aria-label="Next card"]')) { setCardStep((current) => current + 1); setPhase('card-flip') }
      else if (index === 3 && phase === 'card-response' && target.closest('.response-button')) { const next = cardStep + 1; setCardStep(next); setPhase(next >= 3 ? 'review-complete' : 'card-flip') }
    }
    window.addEventListener('click', listen, true)
    return () => window.removeEventListener('click', listen, true)
  }, [cardStep, index, phase])
  useEffect(() => {
    if (phase !== 'paper-write') return
    const timer = window.setInterval(() => {
      const body = document.querySelector('.soflo-editor')?.textContent?.trim() ?? ''
      const header = document.querySelector('.paper-running-header')?.textContent?.trim() ?? ''
      if (body.length >= 3 && header.length >= 1) { setPaperReady(true); setPhase('paper-back') }
    }, 250)
    return () => window.clearInterval(timer)
  }, [phase])
  const runPrimary = async () => {
    setBusy(true)
    try {
      if (phase === 'class-create') { if (await onCreateExample()) setPhase('class-explore') }
      else if (phase === 'class-explore') { move(1); setPhase(document.querySelector('.class-tabs button:nth-child(2)')?.classList.contains('active') ? 'papers-new' : 'papers-tab') }
      else if (phase === 'lecture-created') { onOpenFlashcardSets(); move(3); setPhase('set-new') }
      else if (phase === 'set-created') { if (await onBuildBasics()) setPhase('basic-star') }
      else if (phase === 'study-start') { onStartFlashcards(); setPhase('card-flip') }
      else if (phase === 'review-complete') { move(4); setPhase('finish') }
    } finally { setBusy(false) }
  }
  const removeAndFinish = async () => { setBusy(true); try { if (await onRemoveExample()) onFinish() } finally { setBusy(false) } }
  const actionCopy: Record<string, string> = { 'class-create': 'Create example class', 'class-explore': 'Continue to papers', 'lecture-created': 'Continue', 'set-created': 'Prepare three practice cards', 'study-start': 'Start Flashcards', 'review-complete': 'Continue' }
  const targetByPhase: Record<string, string> = { 'class-create': '[data-walkthrough-action]', 'class-explore': '.class-header', 'papers-tab': '.class-tabs button:nth-child(2)', 'papers-new': '.section-actions .button-primary', 'paper-write': '.document-page', 'paper-back': '.editor-breadcrumb-link', 'lectures-tab': '.class-tabs button:nth-child(3)', 'lectures-new': '.lecture-empty .button-primary', 'lecture-created': '[data-walkthrough-action]', 'flashcards-tab': '.class-tabs button:nth-child(5)', 'set-new': '.new-set-menu > .button', 'set-create': '.new-set-menu .paper-action-menu button:first-child', 'set-created': '[data-walkthrough-action]', 'basic-star': '.editable-card:first-child .card-action:not(.delete)', 'study-start': '[data-walkthrough-action]', 'card-flip': '.flashcard', 'card-next': '.study-footer [aria-label="Next card"]', 'card-response': '.response-button', 'review-complete': '[data-walkthrough-action]', finish: '[data-walkthrough-finish]' }
  const activeSelectors = [targetByPhase[phase] ?? '[data-walkthrough-action]']
  const spotlights = useSpotlightRects(activeSelectors)
  useEffect(() => {
    const blockUnguidedKeys = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const inLitEditor = Boolean(phase === 'paper-write' && target?.matches('.soflo-editor, .document-title, .paper-running-header, .paper-running-footer'))
      const isFlashcardFlip = phase === 'card-flip' && event.key === ' '
      if (isFlashcardFlip) { setPhase(cardStep === 0 ? 'card-next' : 'card-response'); return }
      if (!inLitEditor) { event.preventDefault(); event.stopImmediatePropagation() }
    }
    window.addEventListener('keydown', blockUnguidedKeys, true)
    return () => window.removeEventListener('keydown', blockUnguidedKeys, true)
  }, [cardStep, phase])
  useEffect(() => { const block = (event: MouseEvent) => { event.preventDefault(); event.stopImmediatePropagation() }; window.addEventListener('contextmenu', block, true); return () => window.removeEventListener('contextmenu', block, true) }, [])
  const isFinish = index === 4
  const showPrimary = Boolean(actionCopy[phase])
  const copy = phase === 'papers-tab' ? 'Click Papers in the highlighted class navigation.' : phase === 'papers-new' ? 'Use the highlighted New paper button. Import stays unavailable during the walkthrough.' : phase === 'paper-write' ? 'Type at least a few characters in the body, then double-click the top margin and add a header.' : phase === 'paper-back' ? 'Your paper is ready. Use the highlighted Papers button at the top-left to return to your class.' : phase === 'lectures-tab' ? 'Now open the highlighted Lectures tab.' : phase === 'lectures-new' ? 'Use Start your first lecture in the highlighted center panel.' : phase === 'flashcards-tab' ? 'Open the highlighted Flashcards tab.' : phase === 'set-new' ? 'Open the highlighted New set menu.' : phase === 'set-create' ? 'Choose Create — not Import or Create with AI.' : phase === 'basic-star' ? 'Star the highlighted first card so you know how to save a favorite for later.' : phase === 'card-flip' ? `Open card ${cardStep + 1} of 3 by clicking it.` : phase === 'card-next' ? 'Use the highlighted arrow to move to the next card.' : phase === 'card-response' ? 'Choose I know it or I don’t know it to mark this card.' : phase === 'review-complete' ? 'You have seen all three cards. Continue to finish the walkthrough.' : step.copy
  return <aside className="walkthrough-layer" aria-live="polite"><SpotlightShields rects={spotlights} /><section className="walkthrough-popover" role="dialog" aria-modal="true" aria-label="Guided walkthrough"><p className="eyebrow">SOFLO WALKTHROUGH</p><span className="walkthrough-count">{index + 1} of {walkthroughSteps.length}</span><h2>{step.title}</h2><p>{copy}</p>{index === 1 && paperReady && <small>Nice — your paper and header are both in place.</small>}{showPrimary && <button data-walkthrough-action className="button button-soft walkthrough-action" disabled={busy} onClick={() => void runPrimary()}>{busy ? 'Working...' : actionCopy[phase]}</button>}{isFinish && <div className="walkthrough-finish-actions" data-walkthrough-finish><button className="button button-quiet" disabled={busy || !hasExample} onClick={onFinish}>Keep example class</button><button className="button button-primary" disabled={busy} onClick={() => void removeAndFinish()}>{busy ? 'Removing...' : 'Remove example class'}</button></div>}</section><button className="walkthrough-skip" disabled={busy} onClick={onSkip}>Skip walkthrough</button></aside>
}

function AiSetDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (request: AiSetRequest) => void }) {
  const [sources, setSources] = useState<string[]>([])
  const [pasted, setPasted] = useState('')
  const [title, setTitle] = useState('AI study set')
  const choose = async () => { const picked = await open({ title: 'Choose up to five study documents', multiple: true, directory: false, filters: [{ name: 'Documents', extensions: ['pdf', 'docx'] }] }); if (!picked) return; const next = (Array.isArray(picked) ? picked : [picked]).slice(0, 5); setSources(next) }
  const hasMaterial = Boolean(sources.length || pasted.trim())
  return <div className="paper-dialog-backdrop" role="presentation"><section className="paper-dialog ai-set-dialog ai-set-dialog-simple" role="dialog" aria-modal="true" aria-label="Create flashcards with AI"><header><div><p className="eyebrow">LOCAL AI</p><h2>Create flashcards</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header><form onSubmit={(event) => { event.preventDefault(); if (hasMaterial) onCreate({ sources, pasted, topic: '', guidance: '', title, cardCount: 'auto', depth: 'standard' }) }}><div className="paper-dialog-content"><p>Paste notes, a study guide, or simply describe a topic. Adding files is optional.</p><label>Set name<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>What do you want to study?<textarea autoFocus rows={7} value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="Paste notes here, or write something like: Create cards for introductory Java inheritance." /></label><section className="ai-source-section"><strong>Have files instead?</strong><span>Optionally add up to five PDFs or Word documents.</span><button type="button" className="button button-quiet ai-action" onClick={() => void choose()}><Plus size={15} /> Add files ({sources.length}/5)</button>{sources.length > 0 && <div className="ai-source-list">{sources.map((source) => <span key={source}>{source.split(/[\\/]/).pop()}<button type="button" onClick={() => setSources((current) => current.filter((item) => item !== source))}><X size={13} /></button></span>)}</div>}</section></div><footer><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary ai-action" disabled={!hasMaterial}>Create flashcards</button></footer></form></section></div>
}

export default App
