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
import type { AppSettings, AppView, BootstrapData, CourseClass, DocumentDetail, DocumentFolder, DocumentSummary, Flashcard, FlashcardSetDetail, FlashcardSetSummary, SecurityStatus, Semester } from './lib/types'
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

type ModalState = { type: 'semester' } | { type: 'class'; semesterId?: string } | { type: 'aiSet'; classId: string } | null
type ToastKind = 'success' | 'error'
type Toast = { message: string; type: ToastKind } | null
type AiProgress = { progress: number; message: string }

function App() {
  const [library, setLibrary] = useState<BootstrapData | null>(null)
  const [security, setSecurity] = useState<SecurityStatus | null>(null)
  const [booting, setBooting] = useState(true)
  const [view, setView] = useState<AppView>({ kind: 'home' })
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [documentFolders, setDocumentFolders] = useState<DocumentFolder[]>([])
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
  const [activeSet, setActiveSet] = useState<FlashcardSetDetail | null>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const [commandOpen, setCommandOpen] = useState(false)
  const [globalFindOpen, setGlobalFindOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [toast, setToast] = useState<Toast>(null)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const pendingDocument = useRef<DocumentDetail | null>(null)
  const saveTimer = useRef<number | null>(null)
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
      const [nextDocuments, nextFolders, nextSets, nextCards] = await Promise.all([api.listDocuments(classId), api.listDocumentFolders(classId), api.listSets(classId), api.listAllCards(classId)])
      setDocuments(nextDocuments)
      setDocumentFolders(nextFolders)
      setSets(nextSets)
      setAllCards(nextCards)
    } catch (error) { showToast(error instanceof Error ? error.message : 'Class materials could not be loaded.', 'error') }
  }, [showToast])
  useEffect(() => { void loadLibrary() }, [loadLibrary])
  useEffect(() => { let unlisten: (() => void) | undefined; void listen<number>('ai-download-progress', (event) => setAiDownloadProgress(event.payload)).then((dispose) => { unlisten = dispose }); return () => unlisten?.() }, [])
  useEffect(() => { let unlisten: (() => void) | undefined; void listen('ai-download-finished', () => setAiDownloadProgress(null)).then((dispose) => { unlisten = dispose }); return () => unlisten?.() }, [])
  useEffect(() => { let unlisten: (() => void) | undefined; void listen<AiProgress>('ai-generation-progress', (event) => setAiProgress(event.payload)).then((dispose) => { unlisten = dispose }); return () => unlisten?.() }, [])
  const classId = view.kind === 'class' || view.kind === 'document' || view.kind === 'flashcardSet' || view.kind === 'study' ? view.classId : null
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
  useEffect(() => () => { void flushDocument() }, [flushDocument])
  const closeSafely = useCallback(async () => {
    if (closing.current) return
    closing.current = true
    try {
      await flushDocument()
      await api.syncEncryptedLibrary()
    } catch {
      // A locked library has no in-memory work to flush; the window may still close.
    }
    await invoke('force_close_window')
  }, [flushDocument])
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

  const navigate = (next: AppView) => { void flushDocument(); setView(next) }
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
  const generateAiSet = async (targetClassId: string, sources: string[], guidance: string, title: string) => {
    try {
      const materials = (await Promise.all(sources.map((source) => source.toLowerCase().endsWith('.docx') ? api.importWordText(source) : api.importPdfText(source)))).join('\n\n--- NEXT DOCUMENT ---\n\n')
      const modelPath = await ensureAiModel()
      if (!modelPath) throw new Error('Turn on AI in Settings to create cards with AI.')
      setAiWorking(true); setAiProgress({ progress: 3, message: 'Preparing your study materials' })
      const raw = await api.generateFlashcardsText(modelPath, materials, guidance)
      const match = raw.match(/\[[\s\S]*\]/)
      const generated = JSON.parse(match?.[0] ?? raw) as { front?: string; back?: string }[]
      const cards = generated.filter((card) => card.front?.trim() && card.back?.trim()).slice(0, 40)
      if (!cards.length) throw new Error('The local AI model did not return usable flashcards.')
      const set = await api.createSet({ classId: targetClassId, title: title.trim() || 'AI study set', description: 'Created from your imported materials.' })
      await Promise.all(cards.map((card, position) => api.saveCard({ setId: set.id, front: card.front!.trim(), back: card.back!.trim(), position, isStarred: false })))
      await loadClassContent(targetClassId); setModal(null); navigate({ kind: 'flashcardSet', classId: targetClassId, setId: set.id }); showToast(`${cards.length} flashcards created.`)
    } catch (error) { showToast(error instanceof Error ? error.message : 'Flashcards could not be created from those materials.', 'error') } finally { setAiWorking(false); setAiProgress(null) }
  }
  const updateDocument = (partial: Partial<Pick<DocumentDetail, 'content' | 'contentPlain' | 'title'>>) => {
    setActiveDocument((current) => { if (!current) return current; const next = { ...current, ...partial }; scheduleDocumentSave(next); return next })
  }
  const archiveActiveClass = async () => {
    if (!activeCourse) return
    await api.updateClass({ ...activeCourse, archived: true })
    await loadLibrary(); navigate({ kind: 'home' }); showToast(`${activeCourse.name} has been archived.`)
  }
  const restoreClass = async (course: CourseClass) => { await api.updateClass({ ...course, archived: false }); await loadLibrary(); setArchivedClasses((current) => current.filter((item) => item.id !== course.id)); showToast(`${course.name} has been restored.`) }
  const deleteDocument = async () => { if (!activeDocument) return; await flushDocument(); await api.setDocumentDeleted(activeDocument.id, true); await loadClassContent(activeDocument.classId); navigate({ kind: 'class', classId: activeDocument.classId, tab: 'notes' }); showToast('Paper moved to trash.') }
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
  const completeOnboarding = async (input: { name: string; themeColor: AppSettings['themeColor']; pin?: string; password?: string }) => {
    if (!library) return
    const settings = { ...library.settings, userName: input.name, themeColor: input.themeColor, onboardingCompleted: true }
    try {
      await api.updateSettings(settings)
      if (input.pin || input.password) setSecurity(await api.updateLibrarySecurity({ newPin: input.pin, newPassword: input.password, removePin: false, removePassword: false }))
      setSettings(settings)
    } catch (error) { showToast(error instanceof Error ? error.message : 'Your setup could not be saved.', 'error') }
  }
  const unlockLibrary = async (input: { pin?: string; password?: string }) => {
    const status = await api.unlockLibrary(input)
    setSecurity(status)
    setBooting(true)
    await loadLibrary()
  }

  if (booting) return <div className="boot-screen"><img className="brand-mark" src={sofloMark} alt="" /><strong>SoFlo</strong><i /></div>
  if (security?.locked) return <LockView security={security} onUnlock={unlockLibrary} />
  if (!library) return <div className="boot-screen"><img className="brand-mark" src={sofloMark} alt="" /><strong>SoFlo</strong><i /></div>
  return <div className={`app theme-${library.settings.themeColor} ${library.settings.reduceMotion ? 'reduce-motion' : ''}`}>
    <TitleBar />
    <div className="app-body"><Sidebar semesters={library.semesters} classes={library.classes} activeView={view} collapsed={sidebarCollapsed} onNavigate={navigate} onNewSemester={() => setModal({ type: 'semester' })} onNewClass={openNewClass} onOpenCommand={() => setCommandOpen(true)} />
      <section className="app-content"><button className="sidebar-toggle" aria-label="Toggle sidebar" onClick={() => setSidebarCollapsed((current) => !current)}>{sidebarCollapsed ? <Plus size={17} /> : <Menu size={17} />}</button>
        {view.kind === 'home' && <HomeView semesters={library.semesters} classes={library.classes} recentDocuments={recentDocuments} userName={library.settings.userName} onNewSemester={() => setModal({ type: 'semester' })} onNewClass={() => openNewClass()} onOpenClass={(targetClassId) => navigate({ kind: 'class', classId: targetClassId, tab: 'overview' })} onOpenDocument={(document) => navigate({ kind: 'document', classId: document.classId, documentId: document.id })} />}
        {view.kind === 'calendar' && <CalendarView classes={library.classes} />}
        {view.kind === 'settings' && <SettingsView settings={library.settings} dataLocation={library.dataLocation} security={security} onSettingsChange={setSettings} onSecurityChange={setSecurity} onToast={showToast} />}
        {view.kind === 'help' && <HelpView />}
        {view.kind === 'archive' && <ArchiveView semesters={archivedSemesters} classes={archivedClasses} onRestore={(course) => void restoreClass(course)} />}
        {view.kind === 'class' && activeCourse && <ClassView course={activeCourse} tab={view.tab} documentCount={documents.length} documents={documents} folders={documentFolders} syllabus={syllabus} aiEnabled={Boolean(library.settings.aiEnabled)} trashedDocuments={trashedDocuments} sets={sets} trashedSets={trashedSets} allCards={allCards} onTab={(tab) => navigate({ kind: 'class', classId: activeCourse.id, tab })} onNewDocument={() => void createDocument()} onImportPdf={() => void importPdfAsNewNote()} onImportSyllabus={() => void importSyllabus()} onNewSet={() => void createSet()} onNewAiSet={() => setModal({ type: 'aiSet', classId: activeCourse.id })} onOpenDocument={(document) => navigate({ kind: 'document', classId: activeCourse.id, documentId: document.id })} onTrashDocument={(document) => void trashPaper(document)} onDuplicateDocument={(document, title) => void duplicatePaper(document, title)} onBulkRename={(papers) => void bulkRenamePapers(papers)} onGroupDocuments={(id, targetId) => void groupPapers(id, targetId)} onUngroupDocument={(id) => void ungroupPaper(id)} onOpenSet={(setId) => navigate({ kind: 'flashcardSet', classId: activeCourse.id, setId })} onDuplicateSet={(set, title) => void duplicateSet(set, title)} onTrashSet={(set) => void trashSet(set)} onRestoreDocument={(id) => void restoreDocument(id)} onRestoreSet={(id) => void restoreSet(id)} onArchive={() => void archiveActiveClass()} />}
        {view.kind === 'document' && (activeDocument ? <DocumentEditor document={activeDocument} spellcheck={library.settings.spellcheck} fontSize={library.settings.editorFontSize} readingSurface={library.settings.editorCanvas} saveState={saveState} onChange={(content, contentPlain, title) => updateDocument({ content, contentPlain, title })} onBack={() => navigate({ kind: 'class', classId: activeDocument.classId, tab: 'notes' })} onDelete={() => void deleteDocument()} onDuplicate={() => void duplicateDocument()} /> : <LoadingView />)}
        {view.kind === 'flashcardSet' && (activeSet ? <FlashcardSetEditor set={activeSet} onBack={() => navigate({ kind: 'class', classId: activeSet.classId, tab: 'flashcards' })} onStudy={(mode) => navigate({ kind: 'study', classId: activeSet.classId, setId: activeSet.id, mode })} onUpdated={(set) => { setActiveSet(set); void loadClassContent(set.classId) }} onDelete={() => void deleteSet()} /> : <LoadingView />)}
        {view.kind === 'study' && (activeSet ? <StudyView set={activeSet} mode={view.mode} onBack={() => navigate({ kind: 'flashcardSet', classId: activeSet.classId, setId: activeSet.id })} onModeChange={(mode) => navigate({ kind: 'study', classId: activeSet.classId, setId: activeSet.id, mode })} /> : <LoadingView />)}
      </section>
    </div>
    <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} classes={library.classes} onNavigate={navigate} onNewNote={() => void createDocument()} onNewSet={() => void createSet()} />
    <GlobalFind open={globalFindOpen} onClose={() => setGlobalFindOpen(false)} />
    {modal?.type === 'semester' && <CreateSemesterDialog onClose={() => setModal(null)} onCreate={createSemester} />}
    {modal?.type === 'class' && <CreateClassDialog semesters={library.semesters} initialSemesterId={modal.semesterId} onClose={() => setModal(null)} onCreate={createClass} />}
    {modal?.type === 'aiSet' && <AiSetDialog onClose={() => setModal(null)} onCreate={(sources, guidance, title) => void generateAiSet(modal.classId, sources, guidance, title)} />}
    {toast && <div className={`toast ${toast.type}`} role="status">{toast.type === 'success' ? <Plus size={15} /> : <X size={15} />}{toast.message}</div>}
    {aiConsentOpen && <div className="ai-consent-backdrop" role="presentation"><section className="ai-consent-card" role="dialog" aria-modal="true" aria-label="Use local AI?"><p className="eyebrow">LOCAL ARTIFICIAL INTELLIGENCE</p><h2>This action will use AI.</h2><p>SoFlo will download its compact local model once, then process this document only on your PC. This is your reminder—turn AI off any time in Settings.</p><div><button className="button button-quiet" onClick={() => closeAiConsent(false)}>Return</button><button className="button button-primary" onClick={() => closeAiConsent(true)}>Proceed</button></div></section></div>}
    {aiDownloadProgress !== null && <div className="ai-consent-backdrop" role="presentation"><section className="ai-consent-card ai-download-card" role="dialog" aria-modal="true" aria-label="Downloading local AI model"><p className="eyebrow">PREPARING LOCAL AI</p><h2>Downloading your private model</h2><p>This happens once. Keep SoFlo open while the model is saved on this PC.</p><div className="ai-download-track"><i style={{ width: `${aiDownloadProgress}%` }} /></div><strong>{aiDownloadProgress}%</strong></section></div>}
    {aiWorking && <div className="ai-consent-backdrop ai-progress-backdrop" role="presentation"><section className="ai-consent-card ai-download-card ai-progress-card" role="status" aria-live="polite"><i className="ai-progress-spinner" /><p className="eyebrow">SOFLO AI IS WORKING</p><h2>Making this editable</h2><p>{aiProgress?.message ?? 'Formatting your document on this PC.'}</p><div className="ai-download-track"><i style={{ width: `${aiProgress?.progress ?? 4}%` }} /></div><strong>{aiProgress?.progress ?? 4}% complete</strong></section></div>}
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

function AiSetDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (sources: string[], guidance: string, title: string) => void }) {
  const [sources, setSources] = useState<string[]>([])
  const [guidance, setGuidance] = useState('')
  const [title, setTitle] = useState('AI study set')
  const choose = async () => { const picked = await open({ title: 'Choose up to five study documents', multiple: true, directory: false, filters: [{ name: 'Documents', extensions: ['pdf', 'docx'] }] }); if (!picked) return; const next = (Array.isArray(picked) ? picked : [picked]).slice(0, 5); setSources(next) }
  return <div className="paper-dialog-backdrop" role="presentation"><section className="paper-dialog ai-set-dialog" role="dialog" aria-modal="true" aria-label="Create flashcards with AI"><header><div><p className="eyebrow">LOCAL AI</p><h2>Create flashcards</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header><form onSubmit={(event) => { event.preventDefault(); if (sources.length) onCreate(sources, guidance, title) }}><div className="paper-dialog-content"><p>Add up to five PDFs or Word documents. SoFlo will process them privately on this PC and make editable front/back cards.</p><label>Set name<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><button type="button" className="button button-quiet ai-action" onClick={() => void choose()}><Plus size={15} /> Choose documents ({sources.length}/5)</button>{sources.length > 0 && <div className="ai-source-list">{sources.map((source) => <span key={source}>{source.split(/[\\/]/).pop()}<button type="button" onClick={() => setSources((current) => current.filter((item) => item !== source))}><X size={13} /></button></span>)}</div>}<label>Extra guidance <textarea rows={3} value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="e.g. Focus on chapters 4–6 and the topics my professor called out." /></label></div><footer><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary ai-action" disabled={!sources.length}>Create flashcards</button></footer></form></section></div>
}

export default App
