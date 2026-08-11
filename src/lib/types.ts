export interface Semester {
  id: string
  name: string
  term: string
  year: number
  position: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CourseClass {
  id: string
  semesterId: string
  name: string
  courseCode: string
  professor: string | null
  location: string | null
  schedule: string | null
  icon: string
  accentColor: string
  position: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DocumentSummary {
  id: string
  classId: string
  title: string
  excerpt: string
  isFavorite: boolean
  updatedAt: string
  deletedAt: string | null
  isSyllabus: boolean
  folderId: string | null
  linkedPdfPath: string | null
}

export interface DocumentFolder {
  id: string
  classId: string
  title: string
}

export interface DocumentDetail extends DocumentSummary {
  content: string
  contentPlain: string
  revision: number
  createdAt: string
}

export interface RevisionHistoryEntry {
  id: string
  revision: number
  title: string
  content: string
  contentPlain: string
  createdAt: string
  name: string | null
  source: 'user' | 'soflo-ai'
}

export interface LectureSummary {
  id: string
  classId: string
  courseCode: string
  courseName: string
  lectureDate: string
  scheduledStart: string | null
  scheduledEnd: string | null
  professorSnapshot: string | null
  title: string
  excerpt: string
  updatedAt: string
  createdAt: string
}

export interface LectureDetail extends Omit<LectureSummary, 'excerpt'> {
  content: string
  contentPlain: string
  revision: number
}

export interface FlashcardSetSummary {
  id: string
  classId: string
  title: string
  description: string | null
  cardCount: number
  updatedAt: string
  deletedAt: string | null
}

export interface Flashcard {
  id: string
  setId: string
  front: string
  back: string
  notes: string | null
  imagePath: string | null
  position: number
  isStarred: boolean
  createdAt: string
  updatedAt: string
}

export interface FlashcardSetDetail {
  id: string
  classId: string
  title: string
  description: string | null
  cards: Flashcard[]
  progress: CardProgress[]
  updatedAt: string
}

export interface StudyWebSummary {
  id: string
  classId: string
  flashcardSetId: string
  flashcardSetIds: string[]
  name: string
  cardCount: number
  groupCount: number
  generatedAt: string
  updatedAt: string
  deletedAt: string | null
  outOfDate: boolean
  isManual: boolean
}

export interface StudyWebGroup {
  id: string
  label: string
  color: string
  parentGroupId: string | null
  cardIds: string[]
}

export interface StudyWebNode {
  cardId: string
  x: number
  y: number
  manuallyPositioned: boolean
  pinned: boolean
}

export interface StudyWebRelationship {
  id: string
  sourceCardId: string
  targetCardId: string
  relationshipType: string
  strength: number
}

export interface StudyWebDetail {
  id: string
  classId: string
  flashcardSetId: string
  flashcardSetIds: string[]
  name: string
  generatedAt: string
  updatedAt: string
  outOfDate: boolean
  isManual: boolean
  nodes: StudyWebNode[]
  groups: StudyWebGroup[]
  relationships: StudyWebRelationship[]
}

export interface CardProgress {
  cardId: string
  mastery: 'new' | 'learning' | 'familiar' | 'mastered' | 'needsWork'
  correctCount: number
  incorrectCount: number
  consecutiveCorrect: number
  lastSeenAt: string | null
  dueAt: string | null
}

export interface StudySessionSummary {
  id: string
  setId: string | null
  classId: string | null
  mode: string
  startedAt: string
  completedAt: string | null
}

export interface StudyInsightCard {
  cardId: string
  setId: string
  term: string
  mastery: CardProgress['mastery']
  correctCount: number
  incorrectCount: number
  dueAt: string | null
}

export interface StudyInsights {
  totalCards: number
  newCards: number
  learningCards: number
  familiarCards: number
  masteredCards: number
  needsWorkCards: number
  dueCards: number
  weakCards: StudyInsightCard[]
  strongCards: StudyInsightCard[]
}

export interface AppSettings {
  userName: string
  spellcheck: boolean
  reduceMotion: boolean
  editorFontSize: number
  editorDefaultsVersion: number
  editorCanvas: 'paper' | 'midnight' | 'slate' | 'sepia'
  themeColor: 'purple' | 'red' | 'blue' | 'yellow'
  onboardingCompleted: boolean
  walkthroughCompleted: boolean
  walkthroughSkipped: boolean
  walkthroughStep: string
  walkthroughExampleClassId: string
  walkthroughExampleSemesterId: string
  hideOverviewBanner: boolean
  aiEnabled: boolean
  aiGrammar: boolean
  askForAiUse: boolean
  aiModelPath: string
  aiWritingModelPath: string
  aiGeneralModelTier: 'low' | 'medium' | 'high'
  aiWritingModelTier: 'low' | 'medium' | 'high'
  studyWebAutoPin: boolean
  studyWebGroupHighlights: boolean
  defaultQuestionTypes: string[]
}

export interface SecurityStatus {
  configured: boolean
  locked: boolean
  hasPin: boolean
  hasPassword: boolean
  pinDigits?: 4 | 6
}

export interface BootstrapData {
  semesters: Semester[]
  classes: CourseClass[]
  settings: AppSettings
  dataLocation: string
}

export interface SearchResult {
  kind: 'class' | 'document' | 'lecture' | 'set' | 'card'
  id: string
  parentId: string | null
  title: string
  subtitle: string
}

export interface TestAttemptSummary {
  id: string
  setId: string
  score: number
  correctCount: number
  questionCount: number
  createdAt: string
}

export type AppView =
  | { kind: 'home' }
  | { kind: 'calendar' }
  | { kind: 'class'; classId: string; tab: 'overview' | 'notes' | 'lectures' | 'syllabus' | 'flashcards' | 'studyWeb' | 'trash' }
  | { kind: 'document'; classId: string; documentId: string }
  | { kind: 'lecture'; classId: string; lectureId: string }
  | { kind: 'flashcardSet'; classId: string; setId: string }
  | { kind: 'study'; classId: string; setIds: string[]; mode: 'flashcards' | 'learn' | 'test' | 'match' | 'teachItBack'; cardIds?: string[] }
  | { kind: 'studyWeb'; classId: string; webId: string }
  | { kind: 'archive' }
  | { kind: 'settings' }
  | { kind: 'help' }

export const emptyDocument = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })
