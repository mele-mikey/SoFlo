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
  updatedAt: string
}

export interface CardProgress {
  cardId: string
  mastery: 'new' | 'learning' | 'familiar' | 'mastered'
  correctCount: number
  incorrectCount: number
  consecutiveCorrect: number
  lastSeenAt: string | null
  dueAt: string | null
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
  hideOverviewBanner: boolean
  aiEnabled: boolean
  aiModelPath: string
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
  kind: 'class' | 'document' | 'set' | 'card'
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
  | { kind: 'class'; classId: string; tab: 'overview' | 'notes' | 'syllabus' | 'flashcards' | 'study' | 'trash' }
  | { kind: 'document'; classId: string; documentId: string }
  | { kind: 'flashcardSet'; classId: string; setId: string }
  | { kind: 'study'; classId: string; setId: string; mode: 'flashcards' | 'learn' | 'test' | 'match' }
  | { kind: 'archive' }
  | { kind: 'settings' }
  | { kind: 'help' }

export const emptyDocument = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })
