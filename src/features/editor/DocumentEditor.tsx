import { Color } from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import Typography from '@tiptap/extension-typography'
import Underline from '@tiptap/extension-underline'
import { Extension, Node as TiptapNode, type Editor } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { AlignCenter, AlignLeft, AlignRight, Bold, Check, ChevronDown, ClipboardPaste, Code2, Columns3, FileDown, FileText, Highlighter, ImagePlus, Import, IndentDecrease, IndentIncrease, Italic, Link2, List, ListOrdered, ListTodo, Menu, Palette, Pencil, Pilcrow, Pin, Quote, Redo2, RefreshCw, RemoveFormatting, RotateCcw, Search, Settings2, Sparkles, SpellCheck2, Strikethrough, Subscript as SubscriptIcon, Superscript as SuperscriptIcon, Table2, Underline as UnderlineIcon, Undo2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChangeSet, simplifyChanges } from 'prosemirror-changeset'
import type { DocumentDetail, LectureNoteSuggestion, RevisionHistoryEntry } from '../../lib/types'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { api } from '../../lib/api'
import { importAiFormattedNote, importPdfAsEditableNote } from './pdfImport'
import { isolateMechanicalChange } from './grammar'

interface DocumentEditorProps {
  document: DocumentDetail
  spellcheck: boolean
  aiEnabled: boolean
  aiGrammarEnabled: boolean
  aiModelReady: boolean
  fontSize: number
  readingSurface: 'paper' | 'midnight' | 'slate' | 'sepia'
  saveState: 'saved' | 'saving' | 'error'
  onChange: (content: string, contentPlain: string, title: string) => void
  onSpellcheckChange: (value: boolean) => void
  onAiGrammarEnabledChange: (value: boolean) => void
  grammarProgress: { progress: number; message: string } | null
  onGrammarReview: (text: string, quick: boolean, paperContext: string, adjacentContext: string) => Promise<string>
  onResearchAndGrade: (text: string, paperContext: string) => Promise<string>
  onDefineWord: (word: string, paperContext: string) => Promise<string>
  onAiThesaurus: (word: string, paperContext: string) => Promise<string>
  onVersionHistory: () => Promise<RevisionHistoryEntry[]>
  onNameVersion?: (revisionId: string, name: string) => Promise<void>
  onRestoreVersion?: (revisionId: string) => Promise<Pick<DocumentDetail, 'title' | 'content' | 'contentPlain' | 'revision' | 'updatedAt'>>
  onReleaseAi: () => Promise<void>
  onBack: () => void
  onDelete: () => void
  onDuplicate?: () => void
  collectionLabel?: string
  deleteLabel?: string
  deriveTitle?: boolean
  context?: string
  lectureSuggestions?: LectureNoteSuggestion[]
  sidePanel?: ReactNode
}

const accentColors = ['#000000', '#E7E9F0', '#F08B8B', '#F1BD6A', '#86C59A', '#7EB7ED', '#B79CF4']
const highlights = ['#FFF0A3', '#F5B7D4', '#BFE9DA', '#C7DDF9', '#E6D4FF']
const defaultPaperContext = 'A college-level formal paper using precise, polished, sophisticated language and standard academic grammar.'
type WritingPanelPosition = { left: number; top: number }
type PinnedWritingPanel = {
  id: string
  kind: 'grammar' | 'word'
  position: WritingPanelPosition | null
  pinned: boolean
  issue?: GrammarIssue
  word?: string
  reference?: WordReference | null
  error?: string
}
function savedPanelPosition(key: string): WritingPanelPosition | null {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<WritingPanelPosition>
    return Number.isFinite(value.left) && Number.isFinite(value.top) ? { left: Number(value.left), top: Number(value.top) } : null
  } catch { return null }
}
const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [{ types: ['textStyle'], attributes: { fontSize: { default: null, parseHTML: (element: HTMLElement) => element.style.fontSize || null, renderHTML: (attributes: { fontSize?: string | null }) => attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {} } } }]
  },
})
const OrderedListStyle = Extension.create({
  name: 'orderedListStyle',
  addGlobalAttributes() {
    return [{ types: ['orderedList'], attributes: { listStyle: { default: null, parseHTML: (element: HTMLElement) => element.style.listStyleType || null, renderHTML: (attributes: { listStyle?: string | null }) => attributes.listStyle ? { style: `list-style-type: ${attributes.listStyle}` } : {} } } }]
  },
})
function citationPlaceholderText(label: string) {
  const lower = label.toLocaleLowerCase()
  if (lower.includes('last name')) return 'Last'
  if (lower.includes('first name')) return 'First'
  if (lower.includes('initial')) return 'Initials'
  if (lower.includes('title')) return 'Title'
  if (lower.includes('container')) return 'Container'
  if (lower.includes('publisher')) return 'Publisher'
  if (lower.includes('publication')) return lower.includes('day') ? 'Day' : lower.includes('month') ? 'Month' : lower.includes('year') ? 'Year' : 'Source'
  return 'Field'
}
const CitationPlaceholder = TiptapNode.create({
  name: 'citationPlaceholder',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { label: { default: 'Citation detail' } } },
  parseHTML() { return [{ tag: 'span[data-citation-placeholder]' }] },
  renderHTML({ node }) { const label = String(node.attrs.label || 'Citation detail'); return ['span', { class: 'citation-placeholder', 'data-citation-placeholder': '', 'data-citation-label': label }, citationPlaceholderText(label)] },
  renderText({ node }) { return citationPlaceholderText(String(node.attrs.label || 'Citation detail')) },
})
function changeSelectedBlockIndent(editor: Editor, amount: 1 | -1) {
  if (editor.isActive('table')) return false
  const { from, to } = editor.state.selection
  let transaction = editor.state.tr
  let changed = false
  editor.state.doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return
    const current = typeof node.attrs.indent === 'number' ? node.attrs.indent : 0
    const next = Math.max(0, Math.min(8, current + amount))
    if (next !== current) {
      transaction = transaction.setNodeMarkup(position, undefined, { ...node.attrs, indent: next })
      changed = true
    }
    return false
  })
  if (!changed) return false
  editor.view.dispatch(transaction.scrollIntoView())
  return true
}
function changeSelectedIndent(editor: Editor, amount: 1 | -1) {
  if (editor.isActive('listItem')) return amount > 0 ? editor.commands.sinkListItem('listItem') : editor.commands.liftListItem('listItem')
  return changeSelectedBlockIndent(editor, amount)
}
function changeCurrentFirstLineIndent(editor: Editor, amount: 1 | -1) {
  if (editor.isActive('listItem') || editor.isActive('table') || !editor.state.selection.empty) return false
  const $from = editor.state.selection.$from
  const node = $from.parent
  if ((node.type.name !== 'paragraph' && node.type.name !== 'heading') || $from.parentOffset !== 0) return false
  const current = typeof node.attrs.firstLineIndent === 'number' ? node.attrs.firstLineIndent : 0
  const next = Math.max(0, Math.min(8, current + amount))
  if (next === current) return false
  const position = $from.before($from.depth)
  editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, firstLineIndent: next }))
  return true
}
const PaperIndent = Extension.create({
  name: 'paperIndent',
  addGlobalAttributes() {
    return [{ types: ['paragraph', 'heading'], attributes: {
      indent: { default: 0, parseHTML: (element: HTMLElement) => Number.parseInt(element.dataset.indent ?? '0', 10) || 0, renderHTML: (attributes: { indent?: number }) => attributes.indent ? { 'data-indent': attributes.indent, style: `margin-left: ${attributes.indent * .5}in` } : {} },
      firstLineIndent: { default: 0, parseHTML: (element: HTMLElement) => Number.parseInt(element.dataset.firstLineIndent ?? '0', 10) || 0, renderHTML: (attributes: { firstLineIndent?: number }) => attributes.firstLineIndent ? { 'data-first-line-indent': attributes.firstLineIndent, style: `text-indent: ${attributes.firstLineIndent * .5}in` } : {} },
      hangingIndent: { default: 0, parseHTML: (element: HTMLElement) => Number.parseInt(element.dataset.hangingIndent ?? '0', 10) || 0, renderHTML: (attributes: { hangingIndent?: number }) => attributes.hangingIndent ? { 'data-hanging-indent': attributes.hangingIndent } : {} },
    } }]
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => changeCurrentFirstLineIndent(this.editor, 1) || changeSelectedIndent(this.editor, 1),
      'Shift-Tab': () => changeCurrentFirstLineIndent(this.editor, -1) || changeSelectedIndent(this.editor, -1),
      Backspace: () => changeCurrentFirstLineIndent(this.editor, -1),
    }
  },
})
const PaperMeta = Extension.create({
  name: 'paperMeta',
  addGlobalAttributes() {
    return [{ types: ['doc'], attributes: {
      headerText: { default: '' },
      footerText: { default: '' },
      headerPages: { default: null },
      footerPages: { default: null },
      repeatHeader: { default: false },
      repeatFooter: { default: false },
      showPageNumbers: { default: false },
      aiContext: { default: defaultPaperContext },
    } }]
  },
})
const paperPaginationKey = new PluginKey<DecorationSet>('paperPagination')
const grammarReviewKey = new PluginKey<DecorationSet>('grammarReview')
const historyDiffKey = new PluginKey<DecorationSet>('historyDiff')
const paperGap = 34
const usLetterWidthInches = 8.5
const usLetterHeightInches = 11

type GrammarIssueKind = 'mechanic' | 'style' | 'structure' | 'lecture'
type GrammarIssue = { kind: GrammarIssueKind; original: string; replacement: string; alternatives: string[]; reason: string; category: string; partOfSpeech: string; definition: string; useCase: string; synonyms: string[]; from: number; to: number }
type WordSense = { partOfSpeech: string; definition: string; example: string }
type WordReference = { word: string; pronunciation: string; senses: WordSense[]; synonyms: string[] }
type ThesaurusResult = { query: string; close: string[]; related: string[]; broad: string[] }
function formatRevisionTime(value: string) {
  const parsed = parseRevisionDate(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}
function parseRevisionDate(value: string) {
  return new Date(`${value.replace(' ', 'T')}Z`)
}
function revisionTimeOnly(value: string) {
  const parsed = parseRevisionDate(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
function revisionDayLabel(value: string) {
  const parsed = parseRevisionDate(value)
  if (Number.isNaN(parsed.getTime())) return 'Earlier'
  const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  if (parsed.toDateString() === today.toDateString()) return 'Today'
  if (parsed.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return parsed.toLocaleDateString([], { month: 'long', day: 'numeric', year: parsed.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}
function normalizedRevisionText(content: string, fallback: string) {
  const textForNode = (value: unknown): string => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
    const node = value as { type?: unknown; text?: unknown; attrs?: unknown; content?: unknown }
    if (node.type === 'text') return typeof node.text === 'string' ? node.text : ''
    if (node.type === 'citationPlaceholder') {
      const label = node.attrs && typeof node.attrs === 'object' && typeof (node.attrs as { label?: unknown }).label === 'string' ? String((node.attrs as { label: string }).label) : 'Citation detail'
      return citationPlaceholderText(label)
    }
    if (node.type === 'hardBreak') return '\n'
    const children = Array.isArray(node.content) ? node.content.map(textForNode).join('') : ''
    return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(String(node.type)) ? `${children}\n` : children
  }
  try {
    const parsed = JSON.parse(content) as unknown
    return textForNode(parsed).replace(/\n{3,}/g, '\n\n').trimEnd()
  } catch {
    return fallback.replace(/\b(?:undefined|\[object Object\])\b/g, '').trimEnd()
  }
}
function revisionSummary(entry: RevisionHistoryEntry, older?: RevisionHistoryEntry) {
  if (!older) return 'Starting point'
  const current = normalizedRevisionText(entry.content, entry.contentPlain)
  const previous = normalizedRevisionText(older.content, older.contentPlain)
  if (current === previous) return entry.title !== older.title ? 'Title changed' : 'Formatting changed'
  const currentWords = current.match(/\S+/g)?.length ?? 0
  const previousWords = previous.match(/\S+/g)?.length ?? 0
  const delta = currentWords - previousWords
  if (delta > 0) return `${delta} word${delta === 1 ? '' : 's'} added`
  if (delta < 0) return `${Math.abs(delta)} word${delta === -1 ? '' : 's'} removed`
  return 'Words revised'
}
type RevisionCluster = { id: string; entries: RevisionHistoryEntry[] }
type RevisionDay = { label: string; clusters: RevisionCluster[] }
function groupRevisionTimeline(entries: RevisionHistoryEntry[]): RevisionDay[] {
  const days: RevisionDay[] = []
  for (const entry of entries) {
    const label = revisionDayLabel(entry.createdAt)
    let day = days.at(-1)
    if (!day || day.label !== label) { day = { label, clusters: [] }; days.push(day) }
    const prior = day.clusters.at(-1)
    const latest = prior?.entries.at(-1)
    const closeInTime = latest && Math.abs(parseRevisionDate(latest.createdAt).getTime() - parseRevisionDate(entry.createdAt).getTime()) <= 3 * 60 * 1000
    if (entry.id === 'current' || entry.name || !prior || !closeInTime || prior.entries.some((candidate) => candidate.id === 'current' || Boolean(candidate.name))) {
      day.clusters.push({ id: `${label}-${entry.id}`, entries: [entry] })
    } else prior.entries.push(entry)
  }
  return days
}
function historyDiffDecorations(doc: ProseMirrorNode, olderContent: string, timestamp: string, schema: Schema) {
  try {
  let olderDocument: ProseMirrorNode
  try { olderDocument = schema.nodeFromJSON(safeContent(olderContent)) } catch { return DecorationSet.empty }
  const transform = new Transform(olderDocument)
  transform.replaceWith(0, olderDocument.content.size, doc.content)
  const changes = simplifyChanges(ChangeSet.create(olderDocument).addSteps(doc, transform.mapping.maps, 'history').changes, doc)
  const decorations: Decoration[] = []
  const leafText = (node: ProseMirrorNode) => node.type.name === 'citationPlaceholder' ? citationPlaceholderText(String(node.attrs.label || 'Citation detail')) : ''
  for (const change of changes) {
    const addedText = doc.textBetween(change.fromB, change.toB, ' ', leafText).trim()
    const removedText = olderDocument.textBetween(change.fromA, change.toA, ' ', leafText).trim()
    if (change.toB > change.fromB) {
      const words = addedText.match(/\S+/g)?.length ?? 0
      decorations.push(Decoration.inline(change.fromB, change.toB, { class: 'history-diff-added', 'data-history-tooltip': `Added ${timestamp}${words ? ` · ${words} word${words === 1 ? '' : 's'}` : ''}` }))
    }
    if (removedText) {
      const words = removedText.match(/\S+/g)?.length ?? 0
      const position = Math.max(0, Math.min(doc.content.size, change.fromB))
      decorations.push(Decoration.widget(position, () => { const element = globalThis.document.createElement('span'); element.className = 'history-diff-removed'; element.textContent = removedText; element.dataset.historyTooltip = `Removed ${timestamp}${words ? ` · ${words} word${words === 1 ? '' : 's'}` : ''}`; element.contentEditable = 'false'; return element }, { side: -1, key: `removed-${change.fromA}-${change.toA}-${removedText}` }))
    }
  }
  return DecorationSet.create(doc, decorations)
  } catch {
    // Legacy or partially migrated snapshots should never be able to blank the editor.
    return DecorationSet.empty
  }
}
type WordSelection = { word: string; from: number; to: number }
type ResearchSource = { title: string; publication: string; year: string; type: string; perspective: string; citations: number; url: string }
type ResearchGrade = { grade: string; overview: string; strengths: string[]; improvements: string[]; evidence: string; reasoning: string; writingCraft: Record<string, string>; researchAdvice: string[]; researchQuery: string; sources: ResearchSource[]; sourceNote: string }
function grammarIssueKey(issue: Pick<GrammarIssue, 'kind' | 'original' | 'replacement'>) {
  return `${issue.kind}\u0000${issue.original.toLocaleLowerCase()}\u0000${issue.replacement.toLocaleLowerCase()}`
}
const GrammarReview = Extension.create({
  name: 'grammarReview',
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: grammarReviewKey,
      state: { init: () => DecorationSet.empty, apply: (transaction, old) => (transaction.getMeta(grammarReviewKey) as DecorationSet | undefined) ?? old.map(transaction.mapping, transaction.doc) },
      props: { decorations: (state) => grammarReviewKey.getState(state) },
    })]
  },
})
const HistoryDiff = Extension.create({
  name: 'historyDiff',
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: historyDiffKey,
      state: { init: () => DecorationSet.empty, apply: (transaction, old) => (transaction.getMeta(historyDiffKey) as DecorationSet | undefined) ?? old.map(transaction.mapping, transaction.doc) },
      props: { decorations: (state) => historyDiffKey.getState(state) },
    })]
  },
})
function extractGrammarIssues(raw: string, editor: Editor, allowDeepSuggestions: boolean, bounds?: { from: number; to: number }): GrammarIssue[] {
  let candidates: Array<{ kind?: string; original?: string; replacement?: string; suggestion?: string; alternatives?: unknown; reason?: string; why?: string; explanation?: string; category?: string; partOfSpeech?: string; definition?: string; useCase?: string; synonyms?: unknown }> = []
  try { candidates = JSON.parse(raw) as typeof candidates } catch { return [] }
  const issues: GrammarIssue[] = []
  const used = new Set<string>()
  for (const candidate of candidates.slice(0, 28)) {
    const kindLabel = candidate.kind?.toLocaleLowerCase() ?? ''
    const categoryLabel = candidate.category?.toLocaleLowerCase() ?? ''
    const kind: GrammarIssueKind = kindLabel === 'structure' || kindLabel === 'flow' ? 'structure' : kindLabel === 'style' || kindLabel === 'formal' || kindLabel === 'rewrite' || categoryLabel.includes('formal') || categoryLabel.includes('style') ? 'style' : 'mechanic'
    if (!allowDeepSuggestions && kind !== 'mechanic') continue
    const suppliedOriginal = typeof candidate.original === 'string' ? candidate.original : ''
    const suppliedReplacement = typeof candidate.replacement === 'string' ? candidate.replacement : typeof candidate.suggestion === 'string' ? candidate.suggestion : ''
    let original = suppliedOriginal.trim() || (/^\s{2,3}$/.test(suppliedOriginal) ? suppliedOriginal : '')
    let replacement = suppliedReplacement.trim() || (/^\s{1,3}$/.test(suppliedReplacement) ? suppliedReplacement : '')
    // Small local models sometimes preserve sentence context even when asked
    // for a word-level correction. Keep the useful correction by narrowing
    // both strings to their actual changed fragment.
    if (kind === 'mechanic' && !categoryLabel.includes('agreement') && !categoryLabel.includes('comparative')) ({ original, replacement } = isolateMechanicalChange(original, replacement))
    if (kind === 'style' && (original.trim().split(/\s+/).length > 18 || replacement.trim().split(/\s+/).length > 18)) ({ original, replacement } = isolateMechanicalChange(original, replacement))
    const originalWords = original.trim().split(/\s+/).filter(Boolean)
    const replacementWords = replacement.trim().split(/\s+/).filter(Boolean)
    // AI Review asks for 1–9-word formal rewrites. Allow a small amount of
    // tolerance so one slightly longer, still focused phrase is not discarded.
    const maximumWords = kind === 'mechanic' ? 3 : kind === 'style' ? 18 : 48
    const maximumCharacters = kind === 'mechanic' ? 64 : kind === 'style' ? 160 : 360
    if (!original || !replacement || original === replacement || original.length > maximumCharacters || originalWords.length > maximumWords || replacementWords.length > maximumWords) continue
    let found: { from: number; to: number } | null = null
    editor.state.doc.descendants((node, position) => {
      if (found || !node.isText || !node.text) return
      const needle = original.toLocaleLowerCase()
      let match = node.text.toLocaleLowerCase().indexOf(needle)
      while (match >= 0 && !found) {
        const from = position + match
        const to = from + original.length
        const key = `${from}:${original}`
        if ((!bounds || (from >= bounds.from && to <= bounds.to)) && !used.has(key)) {
          used.add(key)
          found = { from, to }
        }
        match = node.text.toLocaleLowerCase().indexOf(needle, match + needle.length)
      }
    })
    if (found) {
      const match = found as { from: number; to: number }
      const alternatives = [replacement, ...(Array.isArray(candidate.alternatives) ? candidate.alternatives : [])].filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean).filter((value, index, values) => values.findIndex((candidateValue) => candidateValue.toLocaleLowerCase() === value.toLocaleLowerCase()) === index).slice(0, 4)
      issues.push({ kind, original, replacement, alternatives, reason: candidate.reason?.trim() || candidate.why?.trim() || candidate.explanation?.trim() || 'Suggested correction.', category: candidate.category?.trim() || 'Writing', partOfSpeech: candidate.partOfSpeech?.trim() || '', definition: candidate.definition?.trim() || '', useCase: candidate.useCase?.trim() || '', synonyms: Array.isArray(candidate.synonyms) ? candidate.synonyms.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean).slice(0, 3) : [], from: match.from, to: match.to })
    }
  }
  return issues
}

function extractLectureSuggestionIssues(suggestions: LectureNoteSuggestion[], editor: Editor): GrammarIssue[] {
  const issues: GrammarIssue[] = []
  const used = new Set<string>()
  for (const suggestion of suggestions.slice(0, 24)) {
    const original = suggestion.original.trim()
    const replacement = suggestion.replacement.trim()
    const originalWords = original.split(/\s+/).filter(Boolean)
    const replacementWords = replacement.split(/\s+/).filter(Boolean)
    if (!original || !replacement || original === replacement || originalWords.length < 3 || originalWords.length > 35 || replacementWords.length > 70 || original.length > 360 || replacement.length > 760) continue
    let found: { from: number; to: number } | null = null
    editor.state.doc.descendants((node, position) => {
      if (found || !node.isText || !node.text) return
      const match = node.text.toLocaleLowerCase().indexOf(original.toLocaleLowerCase())
      if (match < 0) return
      const key = `${position + match}:${original}`
      if (used.has(key)) return
      used.add(key)
      found = { from: position + match, to: position + match + original.length }
    })
    if (!found) continue
    const match = found as { from: number; to: number }
    issues.push({
      kind: 'lecture', original, replacement, alternatives: [],
      reason: suggestion.reason || 'This fills in missing context from the lecture.',
      category: suggestion.kind === 'clarify' ? 'Lecture clarification' : 'Lecture bridge',
      partOfSpeech: '', definition: '',
      useCase: suggestion.timestamp ? `Matched to ${suggestion.timestamp} in the lecture.` : 'Matched to the lecture transcript.',
      synonyms: [], from: match.from, to: match.to,
    })
  }
  return issues
}

function selectedSingleWord(editor: Editor): WordSelection | null {
  const { from, to } = editor.state.selection
  if (from === to) return null
  const selected = editor.state.doc.textBetween(from, to, ' ').trim()
  return /^\p{L}+(?:[-'’]\p{L}+)*$/u.test(selected) ? { word: selected, from, to } : null
}

function wordAtCursor(editor: Editor) {
  const { from, to, $from } = editor.state.selection
  if (from !== to || !$from.parent.isTextblock) return ''
  const text = $from.parent.textContent
  const index = $from.parentOffset
  const before = text.slice(0, index).match(/[\p{L}'’-]+$/u)?.[0] ?? ''
  const after = text.slice(index).match(/^[\p{L}'’-]+/u)?.[0] ?? ''
  const word = `${before}${after}`
  return /^\p{L}+(?:[-'’]\p{L}+)*$/u.test(word) ? word : ''
}

function selectionStaysInIssue(editor: Editor, issue: GrammarIssue) {
  const { from, to } = editor.state.selection
  return from >= issue.from && to <= issue.to
}

function parseWordReference(raw: string, word: string): WordReference | null {
  try {
    const candidate = JSON.parse(raw) as { word?: unknown; pronunciation?: unknown; senses?: unknown; synonyms?: unknown }
    const senses = Array.isArray(candidate.senses) ? candidate.senses.flatMap((sense): WordSense[] => {
      if (!sense || typeof sense !== 'object') return []
      const value = sense as { partOfSpeech?: unknown; definition?: unknown; example?: unknown }
      const definition = typeof value.definition === 'string' ? value.definition.trim() : ''
      return definition ? [{ partOfSpeech: typeof value.partOfSpeech === 'string' ? value.partOfSpeech.trim() : '', definition, example: typeof value.example === 'string' ? value.example.trim() : '' }] : []
    }).slice(0, 3) : []
    if (!senses.length) return null
    const synonyms = Array.isArray(candidate.synonyms) ? candidate.synonyms.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean).filter((value, index, values) => values.findIndex((other) => other.toLocaleLowerCase() === value.toLocaleLowerCase()) === index).slice(0, 10) : []
    return { word: typeof candidate.word === 'string' && candidate.word.trim() ? candidate.word.trim() : word, pronunciation: typeof candidate.pronunciation === 'string' ? candidate.pronunciation.trim() : '', senses, synonyms }
  } catch { return null }
}

function parseThesaurus(raw: string, query: string): ThesaurusResult | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const words = (key: string) => Array.isArray(value[key])
      ? value[key].filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).filter((item, index, items) => items.findIndex((other) => other.toLocaleLowerCase() === item.toLocaleLowerCase()) === index).slice(0, 6)
      : []
    const result = { query: typeof value.query === 'string' && value.query.trim() ? value.query.trim() : query, close: words('close'), related: words('related'), broad: words('broad') }
    return result.close.length || result.related.length || result.broad.length ? result : null
  } catch { return null }
}

function parseResearchGrade(raw: string): ResearchGrade | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object') return null
    const list = (key: string) => Array.isArray(value[key]) ? value[key].filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 5) : []
    const writingCraft = value.writingCraft && typeof value.writingCraft === 'object' && !Array.isArray(value.writingCraft) ? Object.fromEntries(Object.entries(value.writingCraft as Record<string, unknown>).filter(([, item]) => typeof item === 'string').map(([key, item]) => [key, (item as string).trim()])) : {}
    const sources = Array.isArray(value.sources) ? value.sources.flatMap((item): ResearchSource[] => {
      if (!item || typeof item !== 'object') return []
      const source = item as Record<string, unknown>
      const title = typeof source.title === 'string' ? source.title.trim() : ''
      const url = typeof source.url === 'string' ? source.url.trim() : ''
      return title && url ? [{ title, url, publication: typeof source.publication === 'string' ? source.publication.trim() : '', year: typeof source.year === 'string' ? source.year.trim() : '', type: typeof source.type === 'string' ? source.type.trim() : '', perspective: typeof source.perspective === 'string' ? source.perspective.trim() : '', citations: typeof source.citations === 'number' ? source.citations : 0 }] : []
    }).slice(0, 6) : []
    return { grade: typeof value.grade === 'string' ? value.grade.trim() : '—', overview: typeof value.overview === 'string' ? value.overview.trim() : '', strengths: list('strengths'), improvements: list('improvements'), evidence: typeof value.evidence === 'string' ? value.evidence.trim() : '', reasoning: typeof value.reasoning === 'string' ? value.reasoning.trim() : '', writingCraft, researchAdvice: list('researchAdvice'), researchQuery: typeof value.researchQuery === 'string' ? value.researchQuery.trim() : '', sources, sourceNote: typeof value.sourceNote === 'string' ? value.sourceNote.trim() : '' }
  } catch { return null }
}

function derivePaperTitle(editor: Editor) {
  let firstText = ''
  let heading = ''
  editor.state.doc.forEach((node) => {
    const text = node.textContent.trim().replace(/\s+/g, ' ')
    if (!text) return
    if (!firstText) firstText = text
    if (!heading && node.type.name === 'heading') heading = text
  })
  return (heading || firstText || 'Untitled paper').slice(0, 120)
}

type RunningField = 'page-number' | 'page-count'
type RunningRegion = 'header' | 'footer'
type RunningPageMap = Record<string, string>
type ActiveRunningRegion = { region: RunningRegion; page: number; x: number; y: number } | null

const runningFieldToken: Record<RunningField, string> = {
  'page-number': '{PAGE_NUMBER}',
  'page-count': '{PAGE_COUNT}',
}

function escapeRunningText(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function runningFieldElement(field: RunningField, page: number, pageCount: number) {
  const value = field === 'page-number' ? page : pageCount
  return `<span class="paper-running-dynamic-field" data-soflo-field="${field}" contenteditable="false">${value}</span>`
}

function renderRunningField(template: string, page: number, pageCount: number) {
  const parts = template.split(/(\{PAGE_NUMBER\}|\{PAGE_COUNT\})/g)
  return parts.map((part) => {
    if (part === runningFieldToken['page-number']) return runningFieldElement('page-number', page, pageCount)
    if (part === runningFieldToken['page-count']) return runningFieldElement('page-count', page, pageCount)
    return escapeRunningText(part).replaceAll('\n', '<br>')
  }).join('')
}

function serializeRunningRegion(element: HTMLElement) {
  const clone = element.cloneNode(true) as HTMLElement
  clone.querySelectorAll<HTMLElement>('[data-soflo-field]').forEach((field) => {
    const type = field.dataset.sofloField as RunningField
    field.replaceWith(globalThis.document.createTextNode(runningFieldToken[type] ?? ''))
  })
  return clone.textContent ?? ''
}

function setRunningFieldMarkup(element: HTMLElement, template: string, page: number, pageCount: number) {
  element.innerHTML = renderRunningField(template, page, pageCount)
}

function refreshRunningFieldValues(element: HTMLElement, page: number, pageCount: number) {
  element.querySelectorAll<HTMLElement>('[data-soflo-field]').forEach((field) => {
    field.textContent = field.dataset.sofloField === 'page-count' ? String(pageCount) : String(page)
  })
}

function parseRunningPageMap(value: unknown) {
  if (typeof value === 'string') {
    try { return parseRunningPageMap(JSON.parse(value)) } catch { return {} as RunningPageMap }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as RunningPageMap
  return Object.fromEntries(Object.entries(value).filter(([page, text]) => /^\d+$/.test(page) && typeof text === 'string')) as RunningPageMap
}

function runningTextForPage(pages: RunningPageMap, legacyText: string, repeats: boolean, page: number) {
  if (repeats) return pages['1'] ?? legacyText
  return pages[String(page)] ?? (page === 1 ? legacyText : '')
}

function makeDecoratedRunningRegion(element: HTMLSpanElement, region: RunningRegion, template: string, page: number, pageCount: number) {
  setRunningFieldMarkup(element, template, page, pageCount)
  element.tabIndex = 0
  element.addEventListener('dblclick', (event) => {
    if (element.closest('.version-history-mode')) return
    event.preventDefault()
    event.stopPropagation()
    element.contentEditable = 'true'
    element.classList.add('editing')
    element.classList.remove('empty')
    window.dispatchEvent(new CustomEvent<{ region: RunningRegion; page: number; element: HTMLElement; x: number; y: number }>('soflo:begin-running-region', { detail: { region, page, element, x: event.clientX, y: event.clientY } }))
    element.focus()
  })
  element.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); element.blur() } })
  element.addEventListener('blur', () => {
    if (element.contentEditable !== 'true') return
    element.contentEditable = 'false'
    element.classList.remove('editing')
    window.dispatchEvent(new CustomEvent<{ region: RunningRegion; page: number; value: string }>('soflo:save-running-region', { detail: { region, page, value: serializeRunningRegion(element) } }))
  })
}

function measurePaperBreaks(view: { state: { doc: { forEach: (callback: (node: unknown, offset: number) => void) => void } }; dom: HTMLElement; nodeDOM: (position: number) => Node | null | undefined }) {
  const paper = view.dom.closest<HTMLElement>('.document-page')
  if (!paper) return DecorationSet.empty
  const paperStyle = window.getComputedStyle(paper)
  // The paper is deliberately zoomed for its Google Docs-like working view.
  // client/offset measurements are in layout pixels while getBoundingClientRect
  // is in rendered (zoomed) pixels. Mixing the two made the paginator believe a
  // normal block was 10% too tall and it would leave large blank areas on every
  // kind of paper. Normalize all measured block heights back to layout pixels.
  const logicalPaperWidth = paper.offsetWidth || paper.clientWidth
  const renderedPaperWidth = paper.getBoundingClientRect().width
  const renderedScale = logicalPaperWidth > 0 && renderedPaperWidth > 0
    ? renderedPaperWidth / logicalPaperWidth
    : 1
  const normalizedHeight = (element: HTMLElement) => element.getBoundingClientRect().height / renderedScale
  const pageHeight = logicalPaperWidth * usLetterHeightInches / usLetterWidthInches
  const topInset = Number.parseFloat(paperStyle.paddingTop) || 0
  const bottomInset = Number.parseFloat(paperStyle.paddingBottom) || 0
  const title = paper.querySelector<HTMLElement>('.document-title')
  const titleStyle = title ? window.getComputedStyle(title) : null
  const titleHeight = title ? normalizedHeight(title) + (Number.parseFloat(titleStyle?.marginBottom ?? '0') || 0) : 0
  const firstCapacity = Math.max(120, pageHeight - topInset - bottomInset - titleHeight)
  const laterCapacity = Math.max(120, pageHeight - topInset - bottomInset)
  let used = 0
  let capacity = firstCapacity
  const breaks: Decoration[] = []
  let hasPageBreak = false
  let pageNumber = 1
  const headerText = paper.dataset.runningHeader ?? ''
  const footerText = paper.dataset.runningFooter ?? ''
  const headerPages = parseRunningPageMap(paper.dataset.runningHeaderPages)
  const footerPages = parseRunningPageMap(paper.dataset.runningFooterPages)
  const repeatHeader = paper.dataset.repeatHeader === 'true'
  const repeatFooter = paper.dataset.repeatFooter === 'true'
  // Pagination widgets are direct children of the editor too. Looking a node up
  // by its document position can therefore resolve to a widget or an inner node
  // after the first pass, which makes a small heading appear to be an entire page.
  // Measure only the real top-level editor blocks, in document order.
  const documentBlocks = Array.from(view.dom.children).filter((element) => !element.classList.contains('paper-page-break') && !element.classList.contains('paper-page-tail'))
  let blockIndex = 0
  view.state.doc.forEach((_node, offset) => {
    const nodeDom = documentBlocks[blockIndex++] ?? view.nodeDOM(offset)
    if (!(nodeDom instanceof HTMLElement)) return
    const style = window.getComputedStyle(nodeDom)
    const blockHeight = normalizedHeight(nodeDom) + (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0)
    if (used > 0 && used + blockHeight > capacity) {
      const remaining = Math.max(0, capacity - used)
      const breakHeight = remaining + bottomInset + paperGap + topInset
      const completedPage = pageNumber
      pageNumber += 1
      const nextPage = pageNumber
      breaks.push(Decoration.widget(offset, () => {
        const element = document.createElement('span')
        element.className = 'paper-page-break'
        element.style.height = `${breakHeight}px`
        element.style.setProperty('--paper-break-bottom', `${remaining}px`)
        element.style.setProperty('--paper-break-gap-start', `${remaining + bottomInset}px`)
        element.style.setProperty('--paper-break-gap', `${paperGap}px`)
        element.style.setProperty('--paper-break-bottom-inset', `${bottomInset}px`)
        element.style.setProperty('--paper-break-top-inset', `${topInset}px`)
        const completedFooter = runningTextForPage(footerPages, footerText, repeatFooter, completedPage)
        const footer = document.createElement('span')
        footer.className = `paper-running-footer paper-running-footer-later${completedFooter ? '' : ' empty'}`
        makeDecoratedRunningRegion(footer, 'footer', completedFooter, completedPage, pageNumber)
        element.append(footer)
        const nextHeader = runningTextForPage(headerPages, headerText, repeatHeader, nextPage)
        const header = document.createElement('span')
        header.className = `paper-running-header paper-running-header-later${nextHeader ? '' : ' empty'}`
        makeDecoratedRunningRegion(header, 'header', nextHeader, nextPage, pageNumber)
        element.append(header)
        return element
      }, { key: `paper-break-${offset}-${Math.round(breakHeight)}-${pageNumber}`, side: -1, ignoreSelection: true }))
      hasPageBreak = true
      used = 0
      capacity = laterCapacity
    }
    used += blockHeight
  })
  paper.classList.toggle('is-multipage', hasPageBreak)
  if (paper.dataset.pageCount !== String(pageNumber)) {
    paper.dataset.pageCount = String(pageNumber)
    window.dispatchEvent(new CustomEvent<number>('soflo:page-count', { detail: pageNumber }))
  }
  // The first sheet has its own min-height. Every later sheet needs both the unused
  // writing area *and* the bottom margin, otherwise the last visible sheet ends a
  // little short and appears to grow/shrink while typing.
  const tail = Math.max(0, capacity - used) + bottomInset
  const documentSize = (view.state.doc as unknown as { content: { size: number } }).content.size
  if (hasPageBreak && tail > 0) breaks.push(Decoration.widget(documentSize, () => {
    const element = document.createElement('span')
    element.className = 'paper-page-tail'
    element.style.height = `${tail}px`
    element.style.setProperty('--paper-tail-bottom-inset', `${bottomInset}px`)
    const tailFooter = runningTextForPage(footerPages, footerText, repeatFooter, pageNumber)
    const footer = document.createElement('span')
    footer.className = `paper-running-footer paper-running-footer-tail${tailFooter ? '' : ' empty'}`
    makeDecoratedRunningRegion(footer, 'footer', tailFooter, pageNumber, pageNumber)
    element.append(footer)
    return element
  }, { key: `paper-tail-${Math.round(tail)}-${pageNumber}`, side: 1, ignoreSelection: true }))
  return DecorationSet.create(view.state.doc as never, breaks)
}

const PaperPagination = Extension.create({
  name: 'paperPagination',
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: paperPaginationKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (transaction, oldDecorations) => (transaction.getMeta(paperPaginationKey) as DecorationSet | undefined) ?? oldDecorations.map(transaction.mapping, transaction.doc),
      },
      props: { decorations: (state) => paperPaginationKey.getState(state) },
      view: (view) => {
        let animationFrame: number | null = null
        const update = () => {
          if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
          animationFrame = window.requestAnimationFrame(() => {
            animationFrame = null
            const next = measurePaperBreaks(view)
            const current = paperPaginationKey.getState(view.state) ?? DecorationSet.empty
            const currentSignature = current.find().map((decoration) => `${decoration.from}:${decoration.spec.key}`).join('|')
            const nextSignature = next.find().map((decoration) => `${decoration.from}:${decoration.spec.key}`).join('|')
            if (currentSignature !== nextSignature) view.dispatch(view.state.tr.setMeta(paperPaginationKey, next))
          })
        }
        const observer = new ResizeObserver(update)
        observer.observe(view.dom)
        update()
        return { update, destroy: () => { observer.disconnect(); if (animationFrame !== null) window.cancelAnimationFrame(animationFrame) } }
      },
    })]
  },
})

export function DocumentEditor({ document, spellcheck, aiEnabled, aiGrammarEnabled, aiModelReady, fontSize, readingSurface, saveState, onChange, onSpellcheckChange, onAiGrammarEnabledChange, grammarProgress, onGrammarReview, onResearchAndGrade, onDefineWord, onAiThesaurus, onVersionHistory, onNameVersion, onRestoreVersion, onReleaseAi, onBack, onDelete, onDuplicate, collectionLabel = 'Papers', deleteLabel = 'Move to trash', deriveTitle = true, context, lectureSuggestions = [], sidePanel }: DocumentEditorProps) {
  const [findOpen, setFindOpen] = useState(false)
  const [findValue, setFindValue] = useState('')
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false)
  const [pageMargin, setPageMargin] = useState<'normal' | 'narrow' | 'wide'>('normal')
  const [lineSpacing, setLineSpacing] = useState<'single' | 'docs' | 'one-half' | 'double'>('docs')
  const [paperZoom, setPaperZoom] = useState(110)
  const [paperZoomVisible, setPaperZoomVisible] = useState(false)
  const [editingRegion, setEditingRegion] = useState<ActiveRunningRegion>(null)
  const [headerText, setHeaderText] = useState('')
  const [footerText, setFooterText] = useState('')
  const [headerPages, setHeaderPages] = useState<RunningPageMap>({})
  const [footerPages, setFooterPages] = useState<RunningPageMap>({})
  const [repeatHeader, setRepeatHeader] = useState(false)
  const [repeatFooter, setRepeatFooter] = useState(false)
  const [showPageNumbers, setShowPageNumbers] = useState(false)
  const [pageCount, setPageCount] = useState(1)
  const [pdfMessage, setPdfMessage] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [contextSubmenu, setContextSubmenu] = useState<string | null>(null)
  const [citationMenuOpen, setCitationMenuOpen] = useState(false)
  const [linkDialog, setLinkDialog] = useState<{ url: string; canRemove: boolean } | null>(null)
  const [linkPreview, setLinkPreview] = useState<{ href: string; label: string; x: number; y: number } | null>(null)
  const [imageDialog, setImageDialog] = useState<{ src: string } | null>(null)
  const [tableDialog, setTableDialog] = useState<{ rows: number; cols: number; withHeaderRow: boolean } | null>(null)
  const [grammarIssues, setGrammarIssues] = useState<GrammarIssue[]>([])
  const [lectureSuggestionIssues, setLectureSuggestionIssues] = useState<GrammarIssue[]>([])
  const [grammarOpen, setGrammarOpen] = useState(false)
  const [grammarReviewing, setGrammarReviewing] = useState(false)
  const [researchReviewing, setResearchReviewing] = useState(false)
  const [passiveGrammarReviewing, setPassiveGrammarReviewing] = useState(false)
  const [grammarMessage, setGrammarMessage] = useState('')
  const [selectedGrammarIssue, setSelectedGrammarIssue] = useState<GrammarIssue | null>(null)
  const [researchGrade, setResearchGrade] = useState<ResearchGrade | null>(null)
  const [researchError, setResearchError] = useState('')
  const [wordReference, setWordReference] = useState<WordReference | null>(null)
  const [wordReferenceLoading, setWordReferenceLoading] = useState(false)
  const [wordReferenceError, setWordReferenceError] = useState('')
  const [thesaurusOpen, setThesaurusOpen] = useState(false)
  const [thesaurusQuery, setThesaurusQuery] = useState('')
  const [thesaurusResult, setThesaurusResult] = useState<ThesaurusResult | null>(null)
  const [thesaurusLoading, setThesaurusLoading] = useState(false)
  const [thesaurusError, setThesaurusError] = useState('')
  const [paperContext, setPaperContext] = useState(defaultPaperContext)
  const [paperContextDraft, setPaperContextDraft] = useState(defaultPaperContext)
  const [paperContextOpen, setPaperContextOpen] = useState(false)
  const [grammarPanelPosition, setGrammarPanelPosition] = useState<WritingPanelPosition | null>(() => savedPanelPosition('soflo-grammar-panel-position'))
  const [grammarPanelPinned, setGrammarPanelPinned] = useState(false)
  const [wordReferencePanelPosition, setWordReferencePanelPosition] = useState<WritingPanelPosition | null>(() => savedPanelPosition('soflo-word-reference-panel-position'))
  const [wordReferencePinned, setWordReferencePinned] = useState(false)
  const [pinnedWritingPanels, setPinnedWritingPanels] = useState<PinnedWritingPanel[]>([])
  const [thesaurusPanelPosition, setThesaurusPanelPosition] = useState<WritingPanelPosition | null>(() => savedPanelPosition('soflo-thesaurus-panel-position'))
  const [researchPanelPosition, setResearchPanelPosition] = useState<WritingPanelPosition | null>(() => savedPanelPosition('soflo-research-panel-position'))
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false)
  const [versionHistory, setVersionHistory] = useState<RevisionHistoryEntry[]>([])
  const [versionHistorySelectedId, setVersionHistorySelectedId] = useState('current')
  const [versionHistoryLoading, setVersionHistoryLoading] = useState(false)
  const [versionHistoryError, setVersionHistoryError] = useState('')
  const [expandedVersionGroups, setExpandedVersionGroups] = useState(() => new Set<string>())
  const [namingVersionId, setNamingVersionId] = useState<string | null>(null)
  const [versionName, setVersionName] = useState('')
  const [versionRestoring, setVersionRestoring] = useState(false)
  const currentHistoryEntry = useMemo<RevisionHistoryEntry>(() => ({ id: 'current', revision: document.revision, title: document.title, content: document.content, contentPlain: normalizedRevisionText(document.content, document.contentPlain), createdAt: document.updatedAt, name: null, source: 'user' }), [document.content, document.contentPlain, document.revision, document.title, document.updatedAt])
  const historyTimeline = useMemo(() => [currentHistoryEntry, ...versionHistory.map((entry) => ({ ...entry, contentPlain: normalizedRevisionText(entry.content, entry.contentPlain) }))], [currentHistoryEntry, versionHistory])
  const historyDays = useMemo(() => groupRevisionTimeline(historyTimeline), [historyTimeline])
  const selectedHistoryIndex = Math.max(0, historyTimeline.findIndex((entry) => entry.id === versionHistorySelectedId))
  const selectedHistoryEntry = historyTimeline[selectedHistoryIndex] ?? currentHistoryEntry
  const historyWasOpenRef = useRef(false)
  const linkPreviewRef = useRef<{ href: string; label: string; x: number; y: number } | null>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const activeRunningElementRef = useRef<HTMLElement | null>(null)
  const grammarRequestRef = useRef(false)
  const grammarActiveRequestsRef = useRef(0)
  const manualGrammarRequestRef = useRef(false)
  const grammarReviewGenerationRef = useRef(0)
  const wordReferenceRequestRef = useRef(0)
  const selectedWordReferenceRef = useRef('')
  const selectedWordRangeRef = useRef<WordSelection | null>(null)
  const selectedGrammarIssueRef = useRef<GrammarIssue | null>(null)
  const ignoredGrammarKeysRef = useRef(new Set<string>())
  const grammarIssuesRef = useRef<GrammarIssue[]>([])
  const lectureSuggestionIssuesRef = useRef<GrammarIssue[]>([])
  const aiEnabledRef = useRef(aiEnabled)
  const defineWordRef = useRef(onDefineWord)
  const paperContextRef = useRef(paperContext)
  const grammarPanelPinnedRef = useRef(false)
  const wordReferencePinnedRef = useRef(false)
  const grammarPanelPositionRef = useRef(grammarPanelPosition)
  const wordReferencePanelPositionRef = useRef(wordReferencePanelPosition)
  const wordReferencePanelRef = useRef<{ reference: WordReference | null; loading: boolean; error: string }>({ reference: null, loading: false, error: '' })
  const paperZoomDismissRef = useRef<number | null>(null)
  aiEnabledRef.current = aiEnabled
  defineWordRef.current = onDefineWord
  const grammarReviewRef = useRef<(quick: boolean, pageIndex?: number, prefetched?: boolean) => Promise<boolean>>(async () => false)
  const grammarLastInputAt = useRef(0)
  const grammarLastAutomaticReviewAt = useRef(0)
  const visiblePageReviewRef = useRef({ key: '', visibleAt: 0 })
  const reviewedGrammarPagesRef = useRef(new Set<string>())
  // When AI spelling is enabled, it owns the marks so the editor never mixes
  // its straight interactive underlines with the browser's red squiggles.
  const customAiSpellcheck = aiEnabled && aiGrammarEnabled
  const nativeSpellcheck = spellcheck && !customAiSpellcheck
  const setActiveLinkPreview = (preview: { href: string; label: string; x: number; y: number } | null) => { linkPreviewRef.current = preview; setLinkPreview(preview) }
  const openExternalLink = (href: string) => { void openUrl(href).catch(() => { globalThis.open(href, '_blank', 'noopener,noreferrer') }) }
  const closeWordReference = () => {
    wordReferenceRequestRef.current += 1
    selectedWordReferenceRef.current = ''
    selectedWordRangeRef.current = null
    wordReferencePinnedRef.current = false
    setWordReferencePinned(false)
    setWordReference(null)
    setWordReferenceLoading(false)
    setWordReferenceError('')
  }
  const closeActiveGrammarPanel = () => {
    grammarPanelPinnedRef.current = false
    setGrammarPanelPinned(false)
    selectedGrammarIssueRef.current = null
    setGrammarOpen(false)
    setSelectedGrammarIssue(null)
  }
  const beginWritingPanelDrag = (event: React.PointerEvent<HTMLElement>, setPosition?: (position: WritingPanelPosition) => void) => {
    if ((event.target as Element).closest('button,input,textarea,a')) return
    const panel = event.currentTarget.closest<HTMLElement>('.writing-floating-panel')
    const bounds = panel?.getBoundingClientRect()
    if (!panel || !bounds) return
    const updatePosition = setPosition
      ?? (panel.classList.contains('grammar-sidebar') ? setGrammarPanelPosition : setWordReferencePanelPosition)
    event.preventDefault()
    const origin = { x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top }
    const move = (next: PointerEvent) => updatePosition({
      left: Math.max(12, Math.min(window.innerWidth - bounds.width - 12, origin.left + next.clientX - origin.x)),
      top: Math.max(78, Math.min(window.innerHeight - 90, origin.top + next.clientY - origin.y)),
    })
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  const archiveGrammarPanel = () => {
    const issue = selectedGrammarIssueRef.current
    if (issue) setPinnedWritingPanels((panels) => [...panels, { id: `grammar-${Date.now()}-${Math.random().toString(36).slice(2)}`, kind: 'grammar', position: grammarPanelPositionRef.current, pinned: true, issue }])
    grammarPanelPinnedRef.current = false
    setGrammarPanelPinned(false)
  }
  const archiveWordReferencePanel = () => {
    const word = selectedWordReferenceRef.current
    if (word) setPinnedWritingPanels((panels) => [...panels, { id: `word-${Date.now()}-${Math.random().toString(36).slice(2)}`, kind: 'word', position: wordReferencePanelPositionRef.current, pinned: true, word, reference: wordReferencePanelRef.current.reference, error: wordReferencePanelRef.current.error }])
    wordReferencePinnedRef.current = false
    setWordReferencePinned(false)
  }
  const handleLinkClick = (_view: unknown, _position: number, event: MouseEvent) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
    if (!anchor?.href) return false
    event.preventDefault()
    if (linkPreviewRef.current?.href === anchor.href) {
      setActiveLinkPreview(null)
      openExternalLink(anchor.href)
      return true
    }
    const bounds = anchor.getBoundingClientRect()
    setActiveLinkPreview({ href: anchor.href, label: anchor.textContent?.trim() || anchor.href, x: Math.max(12, Math.min(bounds.left, window.innerWidth - 348)), y: Math.min(bounds.bottom + 9, window.innerHeight - 86) })
    return true
  }
  const handleEditorClick = (view: unknown, position: number, event: MouseEvent) => {
    const citation = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-citation-placeholder]') : null
    if (citation) {
      event.preventDefault()
      const editorView = view as EditorView
      editorView.dispatch(editorView.state.tr.setSelection(NodeSelection.create(editorView.state.doc, position)))
      editorView.focus()
      return true
    }
    const marked = event.target instanceof Element ? event.target.closest<HTMLElement>('.ai-grammar-issue, .ai-writing-style, .ai-writing-structure, .ai-lecture-connection') : null
    const issueIndex = Number(marked?.dataset.grammarIssue)
    if (Number.isInteger(issueIndex) && visibleIssues[issueIndex]) {
      event.preventDefault()
      if (grammarPanelPinnedRef.current) archiveGrammarPanel()
      selectedGrammarIssueRef.current = visibleIssues[issueIndex]
      setSelectedGrammarIssue(visibleIssues[issueIndex])
      setGrammarOpen(true)
      return true
    }
    return handleLinkClick(view, position, event)
  }
  const handleWordReferenceSelection = (nextEditor: Editor) => {
    const selection = selectedSingleWord(nextEditor)
    const currentWord = selection?.word ?? wordAtCursor(nextEditor)
    if (!aiEnabledRef.current) {
      if (selectedWordReferenceRef.current) {
        selectedWordReferenceRef.current = ''
        selectedWordRangeRef.current = null
        setWordReference(null)
        setWordReferenceLoading(false)
        setWordReferenceError('')
      }
      return
    }
    if (selection && selectedGrammarIssueRef.current && grammarPanelPinnedRef.current && !selectionStaysInIssue(nextEditor, selectedGrammarIssueRef.current)) {
      archiveGrammarPanel()
      selectedGrammarIssueRef.current = null
      setGrammarOpen(false)
      setSelectedGrammarIssue(null)
    }
    if (selectedWordReferenceRef.current) {
      if (currentWord && selectedWordReferenceRef.current.toLocaleLowerCase() === currentWord.toLocaleLowerCase()) return
      if (wordReferencePinnedRef.current) archiveWordReferencePanel()
      wordReferenceRequestRef.current += 1
      selectedWordReferenceRef.current = ''
      selectedWordRangeRef.current = null
      setWordReference(null)
      setWordReferenceLoading(false)
      setWordReferenceError('')
    }
    if (!selection) return
    const { word } = selection
    selectedWordReferenceRef.current = word
    selectedWordRangeRef.current = selection
    const request = ++wordReferenceRequestRef.current
    setResearchError('')
    setWordReference(null)
    setWordReferenceError('')
    setWordReferenceLoading(true)
    void defineWordRef.current(word, paperContextRef.current).then((raw) => {
      if (request !== wordReferenceRequestRef.current) return
      const reference = parseWordReference(raw, word)
      if (reference) setWordReference(reference)
      else setWordReferenceError('SoFlo could not prepare a reference for that word.')
    }).catch((error: unknown) => {
      if (request === wordReferenceRequestRef.current) setWordReferenceError(error instanceof Error ? error.message : 'SoFlo could not look up that word.')
    }).finally(() => {
      if (request === wordReferenceRequestRef.current) setWordReferenceLoading(false)
    })
  }
  const content = useMemo(() => safeContent(document.content), [document.content])
  // Tiptap owns its document after creation. Keep the exact content it last
  // emitted so a same-document change that came from the app (such as lecture
  // AI appending formatted notes) is applied, while ordinary typing is not
  // needlessly reloaded underneath the cursor.
  const editorContentRef = useRef(JSON.stringify(content))
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: { HTMLAttributes: { class: 'code-block' } } }),
      Underline, TextStyle, FontSize, OrderedListStyle, CitationPlaceholder, PaperIndent, PaperMeta, PaperPagination, GrammarReview, HistoryDiff, Color, Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }), TaskList, TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
      Image.configure({ inline: false, allowBase64: true }), Table.configure({ resizable: true, allowTableNodeSelection: true }), TableRow, TableHeader, TableCell,
      Superscript, Subscript, Placeholder.configure({ placeholder: 'Start writing…' }), Typography,
    ],
    content,
    editorProps: {
      attributes: { class: 'soflo-editor', spellcheck: String(nativeSpellcheck), style: `font-size: ${fontSize}pt` },
      handleClick: handleEditorClick,
    },
    onUpdate: ({ editor: nextEditor }) => {
      const now = Date.now()
      grammarLastInputAt.current = now
      reviewedGrammarPagesRef.current.clear()
      const nextContent = JSON.stringify(nextEditor.getJSON())
      editorContentRef.current = nextContent
      onChange(nextContent, nextEditor.getText(), deriveTitle ? derivePaperTitle(nextEditor) : document.title)
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      const activeIssue = selectedGrammarIssueRef.current
      if (activeIssue && !grammarPanelPinnedRef.current && !selectionStaysInIssue(nextEditor, activeIssue)) {
        selectedGrammarIssueRef.current = null
        setGrammarOpen(false)
        setSelectedGrammarIssue(null)
      }
      handleWordReferenceSelection(nextEditor)
    },
  })
  const currentId = useRef(document.id)
  const visibleIssues = [...grammarIssues, ...lectureSuggestionIssues]
  useEffect(() => () => {
    if (paperZoomDismissRef.current !== null) window.clearTimeout(paperZoomDismissRef.current)
  }, [])
  const revealPaperZoom = () => {
    setPaperZoomVisible(true)
    if (paperZoomDismissRef.current !== null) window.clearTimeout(paperZoomDismissRef.current)
    paperZoomDismissRef.current = window.setTimeout(() => setPaperZoomVisible(false), 3_000)
  }
  const handlePaperZoom = (event: WheelEvent) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    setPaperZoom((current) => Math.max(70, Math.min(160, current + (event.deltaY < 0 ? 5 : -5))))
    revealPaperZoom()
  }
  const resetPaperZoom = () => {
    setPaperZoom(110)
    revealPaperZoom()
  }
  useEffect(() => {
    if (!editor) return
    const pageWrap = editor.view.dom.closest<HTMLElement>('.editor-page-wrap')
    if (!pageWrap) return
    pageWrap.style.setProperty('--document-zoom', String(paperZoom / 100))
    pageWrap.addEventListener('wheel', handlePaperZoom, { passive: false })
    return () => pageWrap.removeEventListener('wheel', handlePaperZoom)
  }, [editor, paperZoom, handlePaperZoom])
  useEffect(() => {
    if (!editor) return
    const nextContent = safeContent(document.content)
    const nextContentSignature = JSON.stringify(nextContent)
    if (currentId.current === document.id && editorContentRef.current === nextContentSignature) return
    const updatedActiveDocument = currentId.current === document.id
    currentId.current = document.id
    editorContentRef.current = nextContentSignature
    editor.commands.setContent(nextContent, { emitUpdate: false })
    if (updatedActiveDocument) {
      editor.commands.setTextSelection(editor.state.doc.content.size)
      editor.commands.scrollIntoView()
    }
    setGrammarIssues([])
    grammarIssuesRef.current = []
    setLectureSuggestionIssues([])
    lectureSuggestionIssuesRef.current = []
    setGrammarMessage('')
    setGrammarOpen(false)
    setSelectedGrammarIssue(null)
    grammarPanelPinnedRef.current = false
    setGrammarPanelPinned(false)
    setWordReference(null)
    setWordReferenceLoading(false)
    setWordReferenceError('')
    wordReferencePinnedRef.current = false
    setWordReferencePinned(false)
    setPinnedWritingPanels([])
    selectedWordReferenceRef.current = ''
    selectedWordRangeRef.current = null
    ignoredGrammarKeysRef.current.clear()
    reviewedGrammarPagesRef.current.clear()
    grammarLastAutomaticReviewAt.current = 0
    wordReferenceRequestRef.current += 1
    editor.view.dispatch(editor.state.tr.setMeta(grammarReviewKey, DecorationSet.empty))
  }, [document.id, document.content, editor])
  useEffect(() => { grammarIssuesRef.current = grammarIssues }, [grammarIssues])
  useEffect(() => { lectureSuggestionIssuesRef.current = lectureSuggestionIssues }, [lectureSuggestionIssues])
  useEffect(() => {
    if (!editor) return
    const next = extractLectureSuggestionIssues(lectureSuggestions, editor).filter((issue) => !ignoredGrammarKeysRef.current.has(grammarIssueKey(issue)))
    lectureSuggestionIssuesRef.current = next
    setLectureSuggestionIssues(next)
    const all = [...grammarIssuesRef.current, ...next]
    const decorations = DecorationSet.create(editor.state.doc, all.map((issue, index) => Decoration.inline(issue.from, issue.to, { class: issue.kind === 'mechanic' ? 'ai-grammar-issue' : issue.kind === 'style' ? 'ai-writing-style' : issue.kind === 'lecture' ? 'ai-lecture-connection' : 'ai-writing-structure', 'data-grammar-issue': String(index) }, { key: `${issue.from}-${issue.to}-${issue.original}-${issue.kind}` })))
    editor.view.dispatch(editor.state.tr.setMeta(grammarReviewKey, decorations))
  }, [document.id, document.content, editor, lectureSuggestions])
  useEffect(() => { selectedGrammarIssueRef.current = selectedGrammarIssue }, [selectedGrammarIssue])
  useEffect(() => { paperContextRef.current = paperContext }, [paperContext])
  useEffect(() => { grammarPanelPinnedRef.current = grammarPanelPinned }, [grammarPanelPinned])
  useEffect(() => { wordReferencePinnedRef.current = wordReferencePinned }, [wordReferencePinned])
  useEffect(() => { grammarPanelPositionRef.current = grammarPanelPosition; if (!grammarPanelPosition) return; try { globalThis.localStorage?.setItem('soflo-grammar-panel-position', JSON.stringify(grammarPanelPosition)) } catch { /* Local layout preferences are optional. */ } }, [grammarPanelPosition])
  useEffect(() => { wordReferencePanelPositionRef.current = wordReferencePanelPosition; if (!wordReferencePanelPosition) return; try { globalThis.localStorage?.setItem('soflo-word-reference-panel-position', JSON.stringify(wordReferencePanelPosition)) } catch { /* Local layout preferences are optional. */ } }, [wordReferencePanelPosition])
  useEffect(() => { wordReferencePanelRef.current = { reference: wordReference, loading: wordReferenceLoading, error: wordReferenceError } }, [wordReference, wordReferenceLoading, wordReferenceError])
  useEffect(() => { if (!thesaurusPanelPosition) return; try { globalThis.localStorage?.setItem('soflo-thesaurus-panel-position', JSON.stringify(thesaurusPanelPosition)) } catch { /* Local layout preferences are optional. */ } }, [thesaurusPanelPosition])
  useEffect(() => { if (!researchPanelPosition) return; try { globalThis.localStorage?.setItem('soflo-research-panel-position', JSON.stringify(researchPanelPosition)) } catch { /* Local layout preferences are optional. */ } }, [researchPanelPosition])
  useEffect(() => {
    const dismissUnpinnedPanels = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.writing-floating-panel')) return
      setPinnedWritingPanels((panels) => panels.filter((panel) => panel.pinned))
    }
    globalThis.document.addEventListener('mousedown', dismissUnpinnedPanels)
    return () => globalThis.document.removeEventListener('mousedown', dismissUnpinnedPanels)
  }, [])
  useEffect(() => { editor?.setOptions({ editorProps: { attributes: { class: 'soflo-editor', spellcheck: String(nativeSpellcheck), style: `font-size: ${fontSize}pt` }, handleClick: handleEditorClick } }) }, [editor, fontSize, grammarIssues, lectureSuggestionIssues, nativeSpellcheck])
  useEffect(() => { if (editor) editor.view.dispatch(editor.state.tr.setMeta(paperPaginationKey, measurePaperBreaks(editor.view))) }, [editor, fontSize, lineSpacing, pageMargin, headerPages, footerPages, repeatHeader, repeatFooter])
  useEffect(() => {
    if (!editor) return
    const attributes = editor.getAttributes('doc') as { headerText?: string; footerText?: string; headerPages?: unknown; footerPages?: unknown; repeatHeader?: boolean; repeatFooter?: boolean; showPageNumbers?: boolean; aiContext?: string }
    const legacyHeader = attributes.headerText ?? ''
    const legacyFooter = attributes.footerText ?? ''
    const savedHeaderPages = parseRunningPageMap(attributes.headerPages)
    const savedFooterPages = parseRunningPageMap(attributes.footerPages)
    const isLegacyHeader = attributes.headerPages == null && Boolean(legacyHeader)
    const isLegacyFooter = attributes.footerPages == null && Boolean(legacyFooter)
    setHeaderText(legacyHeader)
    setFooterText(legacyFooter)
    setHeaderPages(Object.keys(savedHeaderPages).length ? savedHeaderPages : legacyHeader ? { '1': legacyHeader } : {})
    setFooterPages(Object.keys(savedFooterPages).length ? savedFooterPages : legacyFooter ? { '1': legacyFooter } : {})
    setRepeatHeader(Boolean(attributes.repeatHeader) || isLegacyHeader)
    setRepeatFooter(Boolean(attributes.repeatFooter) || isLegacyFooter)
    setShowPageNumbers(Boolean(attributes.showPageNumbers))
    const nextPaperContext = attributes.aiContext?.trim() || defaultPaperContext
    setPaperContext(nextPaperContext)
    setPaperContextDraft(nextPaperContext)
    setPaperContextOpen(false)
  }, [document.id, editor])
  useEffect(() => {
    const updatePageCount = (event: Event) => setPageCount((event as CustomEvent<number>).detail || 1)
    window.addEventListener('soflo:page-count', updatePageCount)
    return () => window.removeEventListener('soflo:page-count', updatePageCount)
  }, [])
  useEffect(() => {
    if (!editor) return
    const beginRepeatedRegion = (event: Event) => {
      const detail = (event as CustomEvent<{ region: RunningRegion; page: number; element: HTMLElement; x: number; y: number }>).detail
      if (!detail) return
      activeRunningElementRef.current = detail.element
      setEditingRegion({ region: detail.region, page: detail.page, x: detail.x, y: detail.y })
    }
    const saveFromRepeatedRegion = (event: Event) => {
      const detail = (event as CustomEvent<{ region: RunningRegion; page: number; value: string }>).detail
      if (!detail) return
      saveRunningRegion(detail.region, detail.page, detail.value)
    }
    window.addEventListener('soflo:begin-running-region', beginRepeatedRegion)
    window.addEventListener('soflo:save-running-region', saveFromRepeatedRegion)
    return () => { window.removeEventListener('soflo:begin-running-region', beginRepeatedRegion); window.removeEventListener('soflo:save-running-region', saveFromRepeatedRegion) }
  }, [editor, footerPages, footerText, headerPages, headerText, repeatFooter, repeatHeader, showPageNumbers])
  useLayoutEffect(() => {
    const regions: Array<[HTMLDivElement | null, RunningRegion, string]> = [[headerRef.current, 'header', runningTextForPage(headerPages, headerText, repeatHeader, 1)], [footerRef.current, 'footer', runningTextForPage(footerPages, footerText, repeatFooter, 1)]]
    regions.forEach(([element, region, value]) => {
      if (!element) return
      if (element.contentEditable === 'true' && editingRegion?.region === region && editingRegion.page === 1) refreshRunningFieldValues(element, 1, pageCount)
      else setRunningFieldMarkup(element, value, 1, pageCount)
    })
  }, [editingRegion, footerPages, footerText, headerPages, headerText, pageCount, repeatFooter, repeatHeader])
  useEffect(() => {
    if (!editingRegion) return
    const exit = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      const element = activeRunningElementRef.current ?? (editingRegion.region === 'header' ? headerRef.current : footerRef.current)
      element?.blur()
      setEditingRegion(null)
      activeRunningElementRef.current = null
    }
    window.addEventListener('keydown', exit)
    return () => window.removeEventListener('keydown', exit)
  }, [editingRegion])
  useEffect(() => {
    const interceptFind = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        window.dispatchEvent(new Event('soflo:open-find'))
      }
    }
    window.addEventListener('keydown', interceptFind, true)
    return () => window.removeEventListener('keydown', interceptFind, true)
  })
  useEffect(() => {
    if (findOpen) window.setTimeout(() => globalThis.document.getElementById('find-input')?.focus(), 20)
  }, [findOpen])
  useEffect(() => {
    if (!contextMenu) return
    const dismiss = (event?: Event) => { if ((event?.target as Element | null)?.closest('.editor-context-menu')) return; setContextMenu(null); setContextSubmenu(null); setCitationMenuOpen(false) }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    window.addEventListener('click', dismiss)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('click', dismiss); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); window.removeEventListener('keydown', onKeyDown) }
  }, [contextMenu])
  useEffect(() => {
    if (!editor || !aiEnabled || !aiGrammarEnabled || !aiModelReady) return
    const timer = window.setInterval(() => {
      const now = Date.now()
      if (!globalThis.document.hasFocus() || !editor.isFocused || grammarRequestRef.current) return
      const page = visiblePaperPage()
      const pageKey = `${page.from}:${page.to}`
      if (visiblePageReviewRef.current.key !== pageKey) {
        visiblePageReviewRef.current = { key: pageKey, visibleAt: now }
        return
      }
      if (now - visiblePageReviewRef.current.visibleAt < 5_000) return
      if (grammarLastAutomaticReviewAt.current && now - grammarLastAutomaticReviewAt.current < 30_000) return
      grammarLastAutomaticReviewAt.current = now
      void grammarReviewRef.current(true)
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [aiEnabled, aiGrammarEnabled, aiModelReady, editor])
  useEffect(() => {
    if (!editor || !aiEnabled || !aiGrammarEnabled || !aiModelReady) return
    if (editor.getText().trim().length < 3) return
    let cancelled = false
    let timer = 0
    const run = async () => {
      if (cancelled || grammarRequestRef.current || !globalThis.document.hasFocus()) return
      await grammarReviewRef.current(true)
    }
    timer = window.setTimeout(() => { void run() }, 5_200)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [aiEnabled, aiGrammarEnabled, aiModelReady, document.id, editor])
  useEffect(() => () => { void onReleaseAi() }, [document.id, onReleaseAi])
  useEffect(() => {
    const openCitationMenu = () => setCitationMenuOpen(true)
    window.addEventListener('soflo:open-citation', openCitationMenu)
    return () => window.removeEventListener('soflo:open-citation', openCitationMenu)
  }, [])
  useEffect(() => {
    if (!editor) return
    const syncRunningMetadata = () => {
      const attributes = editor.getAttributes('doc') as { headerText?: string; footerText?: string; headerPages?: unknown; footerPages?: unknown; repeatHeader?: boolean; repeatFooter?: boolean; showPageNumbers?: boolean; aiContext?: string }
      const nextHeader = attributes.headerText ?? ''
      const nextFooter = attributes.footerText ?? ''
      const nextHeaderPages = parseRunningPageMap(attributes.headerPages)
      const nextFooterPages = parseRunningPageMap(attributes.footerPages)
      setHeaderText(nextHeader); setFooterText(nextFooter)
      setHeaderPages(Object.keys(nextHeaderPages).length ? nextHeaderPages : nextHeader ? { '1': nextHeader } : {})
      setFooterPages(Object.keys(nextFooterPages).length ? nextFooterPages : nextFooter ? { '1': nextFooter } : {})
      setRepeatHeader(Boolean(attributes.repeatHeader)); setRepeatFooter(Boolean(attributes.repeatFooter)); setShowPageNumbers(Boolean(attributes.showPageNumbers))
      const nextPaperContext = attributes.aiContext?.trim() || defaultPaperContext
      setPaperContext(nextPaperContext); setPaperContextDraft(nextPaperContext)
    }
    if (!versionHistoryOpen) {
      if (!historyWasOpenRef.current) return
      historyWasOpenRef.current = false
      editor.commands.setContent(safeContent(document.content), { emitUpdate: false })
      editor.setEditable(true)
      editor.view.dispatch(editor.state.tr.setMeta(historyDiffKey, DecorationSet.empty))
      syncRunningMetadata()
      return
    }
    historyWasOpenRef.current = true
    editor.setEditable(false)
    editor.commands.setContent(safeContent(selectedHistoryEntry.content), { emitUpdate: false })
    syncRunningMetadata()
    if (selectedHistoryEntry.id === 'current') {
      editor.view.dispatch(editor.state.tr.setMeta(historyDiffKey, DecorationSet.empty))
      return
    }
    const older = historyTimeline[selectedHistoryIndex + 1]
    const decorations = older ? historyDiffDecorations(editor.state.doc, older.content, formatRevisionTime(selectedHistoryEntry.createdAt), editor.schema) : DecorationSet.empty
    editor.view.dispatch(editor.state.tr.setMeta(historyDiffKey, decorations))
  }, [document.content, editor, historyTimeline, selectedHistoryEntry, selectedHistoryIndex, versionHistoryOpen])
  if (!editor) return <div className="editor-loading" />
  const runFind = (value: string) => { setFindValue(value); const finder = (window as Window & { find?: (query: string, caseSensitive?: boolean, backwards?: boolean, wrapAround?: boolean) => boolean }).find; if (value && finder) finder(value, false, false, true) }
  const exportPdf = () => {
    setPdfMessage('Opening your PDF export dialog…')
    try { globalThis.print() } catch { setPdfMessage('SoFlo could not open the PDF export dialog.') }
  }
  const exportDocx = async () => {
    setPdfMessage('Creating a Microsoft Word document…')
    try {
      const path = await api.exportDocumentDocx({
        title: document.title || 'SoFlo document',
        content: JSON.stringify(editor.getJSON()),
        contentPlain: editor.getText(),
      })
      setPdfMessage(`Word document saved to ${path}.`)
    } catch (error) {
      setPdfMessage(error instanceof Error ? error.message : 'SoFlo could not export this Word document.')
    }
  }
  const importPdf = async () => {
    const source = await open({ title: 'Import document into this paper', multiple: false, directory: false, filters: [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'pptx'] }] })
    if (!source || Array.isArray(source)) return
    setPdfMessage('Importing editable text…')
    try {
      const isWord = /\.docx?$/i.test(source)
      const isPresentation = /\.pptx$/i.test(source)
      const extracted = isWord ? await api.importWordText(source) : isPresentation ? await api.importPowerPointText(source) : await api.importPdfText(source)
      const imported = isWord || isPresentation ? importAiFormattedNote(extracted, source, extracted) : importPdfAsEditableNote(extracted, source)
      editor.chain().focus().setTextSelection(editor.state.doc.content.size).insertContent(imported.document.content).run()
      setPdfMessage('Structured PDF content added to the end of this paper.')
    } catch (error) { setPdfMessage(error instanceof Error ? error.message : 'SoFlo could not import that PDF.') }
  }
  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    setContextSubmenu(null)
    setCitationMenuOpen(false)
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 222), y: Math.min(event.clientY, window.innerHeight - 270) })
  }
  const runContextAction = async (action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => {
    setContextMenu(null)
    setContextSubmenu(null)
    setCitationMenuOpen(false)
    if (action === 'undo') { editor.chain().focus().undo().run(); return }
    if (action === 'redo') { editor.chain().focus().redo().run(); return }
    if (action === 'selectAll') { editor.chain().focus().selectAll().run(); return }
    editor.commands.focus()
    if (action === 'paste') {
      if (globalThis.document.execCommand('paste')) return
      try { const plain = await navigator.clipboard.readText(); if (plain) editor.commands.insertContent(plain) } catch { /* Clipboard permission is controlled by the operating system. */ }
      return
    }
    if (globalThis.document.execCommand(action)) return
    const { from, to } = editor.state.selection
    const text = editor.state.doc.textBetween(from, to, '\n')
    try { await navigator.clipboard.writeText(text); if (action === 'cut') editor.commands.deleteSelection() } catch { /* The browser command is the best available fallback. */ }
  }
  const insertCitation = (style: 'mla' | 'apa' | 'chicago') => {
    const placeholder = (label: string) => ({ type: 'citationPlaceholder', attrs: { label } })
    const text = (value: string) => ({ type: 'text', text: value })
    const templates = {
      mla: [placeholder('Author last name'), text(', '), placeholder('Author first name'), text('. “'), placeholder('Title of the work'), text('.” '), placeholder('Publication or container'), text(', '), placeholder('Publisher'), text(', '), placeholder('Publication day'), text(' '), placeholder('Publication month'), text(' '), placeholder('Publication year'), text('.')],
      apa: [placeholder('Author last name'), text(', '), placeholder('Author initials'), text('. ('), placeholder('Publication year'), text(', '), placeholder('Publication month'), text(' '), placeholder('Publication day'), text('). '), placeholder('Title of the work'), text('. '), placeholder('Publisher or publication'), text('.')],
      chicago: [placeholder('Author first name'), text(' '), placeholder('Author last name'), text('. “'), placeholder('Title of the work'), text('.” '), placeholder('Publication or container'), text(', '), placeholder('Publication month'), text(' '), placeholder('Publication day'), text(', '), placeholder('Publication year'), text('.')],
    }
    editor.chain().focus().insertContent([text(' '), ...templates[style]]).run()
    setContextMenu(null)
    setContextSubmenu(null)
    setCitationMenuOpen(false)
  }
  const openVersionHistory = async () => {
    setGrammarOpen(false); setSelectedGrammarIssue(null); setResearchGrade(null); setThesaurusOpen(false); setWordReference(null)
    setEditingRegion(null); setFindOpen(false); setPageSettingsOpen(false); setContextMenu(null); setCitationMenuOpen(false)
    setVersionHistoryOpen(true)
    setVersionHistorySelectedId('current')
    setVersionHistoryLoading(true)
    setVersionHistoryError('')
    try { setVersionHistory(await onVersionHistory()) } catch (error) { setVersionHistoryError(error instanceof Error ? error.message : 'Version history could not be loaded.') } finally { setVersionHistoryLoading(false) }
  }
  const closeVersionHistory = () => {
    setVersionHistoryOpen(false)
    setVersionHistorySelectedId('current')
    setNamingVersionId(null)
  }
  const saveVersionName = async (entry: RevisionHistoryEntry) => {
    try {
      if (onNameVersion) await onNameVersion(entry.id, versionName.trim())
      else if (collectionLabel === 'Lectures') await api.nameLectureRevision(entry.id, versionName.trim())
      else await api.nameDocumentRevision(entry.id, versionName.trim())
      setVersionHistory(await onVersionHistory())
      setNamingVersionId(null)
    } catch (error) { setVersionHistoryError(error instanceof Error ? error.message : 'That version could not be named.') }
  }
  const restoreSelectedVersion = async () => {
    if (selectedHistoryEntry.id === 'current' || versionRestoring) return
    setVersionRestoring(true)
    setVersionHistoryError('')
    try {
      const restored = onRestoreVersion ? await onRestoreVersion(selectedHistoryEntry.id) : collectionLabel === 'Lectures' ? await api.restoreLectureRevision(document.id, selectedHistoryEntry.id) : await api.restoreDocumentRevision(document.id, selectedHistoryEntry.id)
      onChange(restored.content, restored.contentPlain, restored.title)
      setVersionHistory(await onVersionHistory())
      setVersionHistorySelectedId('current')
    } catch (error) { setVersionHistoryError(error instanceof Error ? error.message : 'That version could not be restored.') } finally { setVersionRestoring(false) }
  }
  const setGrammarDecorations = (issues: GrammarIssue[]) => {
    const decorations = DecorationSet.create(editor.state.doc, issues.map((issue, index) => Decoration.inline(issue.from, issue.to, { class: issue.kind === 'mechanic' ? 'ai-grammar-issue' : issue.kind === 'style' ? 'ai-writing-style' : issue.kind === 'lecture' ? 'ai-lecture-connection' : 'ai-writing-structure', 'data-grammar-issue': String(index) }, { key: `${issue.from}-${issue.to}-${issue.original}-${issue.kind}` })))
    editor.view.dispatch(editor.state.tr.setMeta(grammarReviewKey, decorations))
  }
  const visiblePaperPage = (requestedPage?: number) => {
    const documentSize = editor.state.doc.content.size
    const breaks = (paperPaginationKey.getState(editor.state) ?? DecorationSet.empty).find()
      .filter((decoration) => String(decoration.spec.key ?? '').startsWith('paper-break-'))
      .map((decoration) => decoration.from)
      .sort((left, right) => left - right)
    if (!breaks.length) return { text: editor.getText(), from: 0, to: documentSize, index: 0, pageCount: 1, adjacentContext: '' }

    const scrollArea = editor.view.dom.closest<HTMLElement>('.editor-page-wrap')
    const visibleCenter = scrollArea
      ? scrollArea.getBoundingClientRect().top + scrollArea.clientHeight / 2
      : window.innerHeight / 2
    const pageBreaks = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.paper-page-break'))
    let visiblePage = 0
    pageBreaks.forEach((element, index) => {
      if (element.getBoundingClientRect().bottom <= visibleCenter) visiblePage = index + 1
    })
    if (requestedPage !== undefined) visiblePage = Math.max(0, Math.min(requestedPage, breaks.length))

    const pageStarts = [0, ...breaks]
    const start = pageStarts[Math.min(visiblePage, pageStarts.length - 1)]
    const end = pageStarts[visiblePage + 1] ?? documentSize
    const previousStart = visiblePage > 0 ? pageStarts[visiblePage - 1] : 0
    const nextEnd = pageStarts[visiblePage + 2] ?? documentSize
    // These are boundary context only, never targets for suggestions. Keep the
    // closest portion of an unusually dense neighboring page so a sentence
    // split by pagination still reads naturally without sending the full paper.
    const previous = visiblePage > 0
      ? editor.state.doc.textBetween(previousStart, start, '\n').trim().slice(-5_000)
      : ''
    const next = end < documentSize
      ? editor.state.doc.textBetween(end, nextEnd, '\n').trim().slice(0, 5_000)
      : ''
    const adjacentContext = [
      previous && `PREVIOUS PAGE (context only)\n${previous}`,
      next && `NEXT PAGE (context only)\n${next}`,
    ].filter(Boolean).join('\n\n')
    return { text: editor.state.doc.textBetween(start, end, '\n').trim() || editor.getText(), from: start, to: end, index: visiblePage, pageCount: breaks.length + 1, adjacentContext }
  }
  const reviewGrammar = async (quick = false, requestedPage?: number, prefetched = false) => {
    if (!aiEnabled || !aiGrammarEnabled || !aiModelReady) return false
    // A quiet check may already be using the local model. A full review is
    // intentional, so let it take priority and ignore the older quiet result.
    if (quick && grammarRequestRef.current) return false
    if (!quick && manualGrammarRequestRef.current) return false
    const generation = ++grammarReviewGenerationRef.current
    grammarActiveRequestsRef.current += 1
    grammarRequestRef.current = true
    if (!quick) manualGrammarRequestRef.current = true
    if (quick) setPassiveGrammarReviewing(true)
    else {
      setGrammarReviewing(true)
      setGrammarMessage('')
      editor.view.dom.classList.add('ai-grammar-scanning')
    }
    try {
      // The paper is visually paginated inside one ProseMirror document. Both
      // quiet checks and AI Review must examine the complete page the person is
      // viewing, rather than always beginning at page one of a longer paper.
      const page = visiblePaperPage(requestedPage)
      const pageKey = `${page.from}:${page.to}:${page.text}`
      if (quick && reviewedGrammarPagesRef.current.has(pageKey)) return true

      // AI Review is a three-page window: the page being read receives the
      // detailed review, while the pages immediately before and after receive
      // quick mechanics checks. The neighboring pages are real targets here,
      // not merely sentence-boundary context, so their marks appear too.
      const reviewTargets = [
        { page, quick },
        ...(!quick && requestedPage === undefined
          ? [page.index - 1, page.index + 1]
            .filter((index) => index >= 0 && index < page.pageCount)
            .map((index) => ({ page: visiblePaperPage(index), quick: true }))
          : []),
      ]
      const issues: GrammarIssue[] = []
      for (const target of reviewTargets) {
        const targetKey = `${target.page.from}:${target.page.to}:${target.page.text}`
        if (target.quick && reviewedGrammarPagesRef.current.has(targetKey)) continue
        const response = await onGrammarReview(target.page.text, target.quick, paperContext, target.page.adjacentContext)
        issues.push(...extractGrammarIssues(response, editor, !target.quick, target.page)
          .filter((issue) => !ignoredGrammarKeysRef.current.has(grammarIssueKey(issue))))
        if (target.quick) reviewedGrammarPagesRef.current.add(targetKey)
      }
      // A manual review started after a passive pass should replace that pass,
      // never be overwritten by an older background response.
      if (generation !== grammarReviewGenerationRef.current) return false
      if (quick) {
        const combined = grammarIssues.filter((issue) => {
          if (ignoredGrammarKeysRef.current.has(grammarIssueKey(issue))) return false
          return editor.state.doc.textBetween(issue.from, issue.to, ' ').toLocaleLowerCase() === issue.original.toLocaleLowerCase()
        })
        for (const issue of issues) {
          if (!combined.some((current) => current.from === issue.from && current.to === issue.to && current.kind === issue.kind)) combined.push(issue)
        }
        grammarIssuesRef.current = combined
        setGrammarIssues(combined)
        setGrammarDecorations([...combined, ...lectureSuggestionIssuesRef.current])
      } else if (issues.length) {
        // A manual AI Review is the authoritative, deeper pass. It replaces the
        // small automatic pass that may already be visible.
        grammarIssuesRef.current = issues
        setGrammarIssues(issues)
        setGrammarDecorations([...issues, ...lectureSuggestionIssuesRef.current])
      } else {
        setGrammarMessage('AI Review could not shape its suggestions this time. Your paper has not been changed.')
      }
      if (!quick) {
        setGrammarOpen(false)
        setSelectedGrammarIssue(null)
      }
      if (quick) {
        reviewedGrammarPagesRef.current.add(pageKey)
        // After the page the student paused on is ready, quietly prepare the
        // next page once. Scrolling forward therefore shows existing marks,
        // while this never turns one pause into a whole-document AI run.
        if (!prefetched && page.to < editor.state.doc.content.size) {
          window.setTimeout(() => {
            if (!grammarRequestRef.current) void grammarReviewRef.current(true, page.index + 1, true)
          }, 120)
        }
      } else {
        reviewedGrammarPagesRef.current.add(pageKey)
      }
      return issues.length > 0
    } catch (error) {
      if (!quick) {
        setGrammarMessage(error instanceof Error ? error.message : 'SoFlo could not finish this grammar review. Your current checks are still available.')
      }
      return false
    } finally {
      if (quick) setPassiveGrammarReviewing(false)
      else {
        editor.view.dom.classList.remove('ai-grammar-scanning')
        setGrammarReviewing(false)
      }
      grammarActiveRequestsRef.current = Math.max(0, grammarActiveRequestsRef.current - 1)
      grammarRequestRef.current = grammarActiveRequestsRef.current > 0
      if (!quick) manualGrammarRequestRef.current = false
    }
  }
  grammarReviewRef.current = reviewGrammar
  const runResearchAndGrade = async () => {
    if (!aiEnabled || researchReviewing) return
    setResearchReviewing(true)
    setResearchError('')
    try {
      const report = parseResearchGrade(await onResearchAndGrade(editor.getText(), paperContext))
      if (!report) throw new Error('SoFlo could not prepare a research and grade report from the local AI response.')
      setResearchGrade(report)
    } catch (error) {
      setResearchError(error instanceof Error ? error.message : 'SoFlo could not research and grade this paper.')
    } finally { setResearchReviewing(false) }
  }
  const runThesaurus = async (event?: FormEvent) => {
    event?.preventDefault()
    const query = thesaurusQuery.trim()
    if (!query || thesaurusLoading) return
    setThesaurusLoading(true)
    setThesaurusError('')
    setThesaurusResult(null)
    try {
      const result = parseThesaurus(await onAiThesaurus(query, paperContext), query)
      if (!result) throw new Error('SoFlo could not prepare grouped thesaurus suggestions.')
      setThesaurusResult(result)
    } catch (error) {
      setThesaurusError(error instanceof Error ? error.message : 'SoFlo could not find related words.')
    } finally { setThesaurusLoading(false) }
  }
  const openThesaurus = () => {
    setThesaurusOpen(true)
  }
  const applyGrammarIssue = (issue: GrammarIssue, replacement = issue.replacement) => {
    if (issue.kind === 'structure') return
    const state = editor.state
    const exact = state.doc.textBetween(issue.from, issue.to, ' ')
    if (exact.toLocaleLowerCase() !== issue.original.toLocaleLowerCase()) return
    const transaction = state.tr.insertText(replacement, issue.from, issue.to).scrollIntoView()
    editor.view.dispatch(transaction)
    if (issue.kind === 'lecture') ignoredGrammarKeysRef.current.add(grammarIssueKey(issue))
    const nextGrammar = grammarIssuesRef.current.filter((current) => current !== issue).map((current) => ({ ...current, from: transaction.mapping.map(current.from, -1), to: transaction.mapping.map(current.to, 1) }))
    const nextLecture = lectureSuggestionIssuesRef.current.filter((current) => current !== issue).map((current) => ({ ...current, from: transaction.mapping.map(current.from, -1), to: transaction.mapping.map(current.to, 1) }))
    grammarIssuesRef.current = nextGrammar
    lectureSuggestionIssuesRef.current = nextLecture
    setGrammarIssues(nextGrammar)
    setLectureSuggestionIssues(nextLecture)
    setGrammarDecorations([...nextGrammar, ...nextLecture])
    grammarPanelPinnedRef.current = false
    setGrammarPanelPinned(false)
    setGrammarOpen(false)
    setSelectedGrammarIssue(null)
  }
  const ignoreGrammarIssue = (issue: GrammarIssue) => {
    ignoredGrammarKeysRef.current.add(grammarIssueKey(issue))
    const nextGrammar = grammarIssuesRef.current.filter((current) => grammarIssueKey(current) !== grammarIssueKey(issue))
    const nextLecture = lectureSuggestionIssuesRef.current.filter((current) => grammarIssueKey(current) !== grammarIssueKey(issue))
    grammarIssuesRef.current = nextGrammar
    lectureSuggestionIssuesRef.current = nextLecture
    setGrammarIssues(nextGrammar)
    setLectureSuggestionIssues(nextLecture)
    setGrammarDecorations([...nextGrammar, ...nextLecture])
    grammarPanelPinnedRef.current = false
    setGrammarPanelPinned(false)
    selectedGrammarIssueRef.current = null
    setGrammarOpen(false)
    setSelectedGrammarIssue(null)
  }
  const useWordAlternative = (alternative: string) => {
    const range = selectedWordRangeRef.current
    if (!range) return
    let from = range.from
    let to = range.to
    const selectedWord = range.word.toLocaleLowerCase()
    if (editor.state.doc.textBetween(from, to, ' ').toLocaleLowerCase() !== selectedWord) {
      let nearestFrom = -1
      let nearestTo = -1
      let nearestDistance = Number.POSITIVE_INFINITY
      editor.state.doc.descendants((node, position) => {
        if (!node.isText || !node.text) return
        let start = node.text.toLocaleLowerCase().indexOf(selectedWord)
        while (start >= 0) {
          const candidateFrom = position + start
          const candidateDistance = Math.abs(candidateFrom - range.from)
          if (candidateDistance < nearestDistance) {
            nearestFrom = candidateFrom
            nearestTo = candidateFrom + range.word.length
            nearestDistance = candidateDistance
          }
          start = node.text.toLocaleLowerCase().indexOf(selectedWord, start + range.word.length)
        }
      })
      if (nearestFrom < 0) return
      from = nearestFrom
      to = nearestTo
    }
    const transaction = editor.state.tr.insertText(alternative, from, to).scrollIntoView()
    editor.view.dispatch(transaction)
    void navigator.clipboard.writeText(alternative).catch(() => undefined)
    wordReferenceRequestRef.current += 1
    selectedWordReferenceRef.current = ''
    selectedWordRangeRef.current = null
    setWordReference(null)
    setWordReferenceLoading(false)
    setWordReferenceError('')
    editor.commands.focus()
  }
  const savePaperContext = () => {
    const nextContext = paperContextDraft.trim() || defaultPaperContext
    editor.commands.updateAttributes('doc', { aiContext: nextContext })
    setPaperContext(nextContext)
    setPaperContextDraft(nextContext)
    setPaperContextOpen(false)
  }
  const openPaperContext = () => {
    setPaperContextDraft(paperContext)
    setPaperContextOpen(true)
  }
  const openLinkDialog = () => setLinkDialog({ url: (editor.getAttributes('link').href as string | undefined) ?? '', canRemove: editor.isActive('link') })
  const applyLink = (url: string) => {
    const href = url.trim()
    if (!href) return
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    setLinkDialog(null)
  }
  const insertImage = (src: string) => {
    if (!src.trim()) return
    editor.chain().focus().setImage({ src }).run()
    setImageDialog(null)
  }
  const insertTable = (table: { rows: number; cols: number; withHeaderRow: boolean }) => {
    editor.chain().focus().insertTable(table).run()
    setTableDialog(null)
  }
  const persistRunningMeta = (nextHeaderPages: RunningPageMap, nextFooterPages: RunningPageMap, nextRepeatHeader: boolean, nextRepeatFooter: boolean) => {
    const nextHeaderText = nextHeaderPages['1'] ?? ''
    const nextFooterText = nextFooterPages['1'] ?? ''
    editor.commands.updateAttributes('doc', { headerText: nextHeaderText, footerText: nextFooterText, headerPages: nextHeaderPages, footerPages: nextFooterPages, repeatHeader: nextRepeatHeader, repeatFooter: nextRepeatFooter, showPageNumbers })
    setHeaderText(nextHeaderText); setFooterText(nextFooterText)
    setHeaderPages(nextHeaderPages); setFooterPages(nextFooterPages)
    setRepeatHeader(nextRepeatHeader); setRepeatFooter(nextRepeatFooter)
  }
  const saveRunningRegion = (region: RunningRegion, page: number, value: string) => {
    const next = value.trim()
    if (region === 'header') {
      const nextPages = { ...headerPages }
      const targetPage = repeatHeader ? '1' : String(page)
      if (next) nextPages[targetPage] = next
      else delete nextPages[targetPage]
      persistRunningMeta(nextPages, footerPages, repeatHeader, repeatFooter)
    } else {
      const nextPages = { ...footerPages }
      const targetPage = repeatFooter ? '1' : String(page)
      if (next) nextPages[targetPage] = next
      else delete nextPages[targetPage]
      persistRunningMeta(headerPages, nextPages, repeatHeader, repeatFooter)
    }
    setEditingRegion(null)
    activeRunningElementRef.current = null
  }
  const toggleRunningRepeat = () => {
    if (!editingRegion) return
    const { region, page } = editingRegion
    const element = activeRunningElementRef.current
    const currentValue = element ? serializeRunningRegion(element).trim() : runningTextForPage(region === 'header' ? headerPages : footerPages, region === 'header' ? headerText : footerText, region === 'header' ? repeatHeader : repeatFooter, page)
    if (region === 'header') {
      const nextRepeat = !repeatHeader
      const nextPages = nextRepeat ? { '1': currentValue } : Object.fromEntries(Array.from({ length: pageCount }, (_, index) => [String(index + 1), headerPages['1'] ?? currentValue])) as RunningPageMap
      persistRunningMeta(nextPages, footerPages, nextRepeat, repeatFooter)
    } else {
      const nextRepeat = !repeatFooter
      const nextPages = nextRepeat ? { '1': currentValue } : Object.fromEntries(Array.from({ length: pageCount }, (_, index) => [String(index + 1), footerPages['1'] ?? currentValue])) as RunningPageMap
      persistRunningMeta(headerPages, nextPages, repeatHeader, nextRepeat)
    }
  }
  const insertRunningField = (field: 'page-number' | 'page-x-of-y') => {
    const element = activeRunningElementRef.current ?? (editingRegion?.region === 'header' ? headerRef.current : footerRef.current)
    if (!element || !editingRegion) return
    const selection = window.getSelection()
    const range = selection?.rangeCount && selection.getRangeAt(0)
    const insertAtCaret = range && element.contains(range.commonAncestorContainer)
    const fragment = globalThis.document.createDocumentFragment()
    const addField = (type: RunningField) => {
      const dynamicField = globalThis.document.createElement('span')
      dynamicField.className = 'paper-running-dynamic-field'
      dynamicField.dataset.sofloField = type
      dynamicField.contentEditable = 'false'
      dynamicField.textContent = type === 'page-count' ? String(pageCount) : String(editingRegion.page)
      fragment.append(dynamicField)
    }
    if (field === 'page-x-of-y') {
      fragment.append(globalThis.document.createTextNode('Page ')); addField('page-number'); fragment.append(globalThis.document.createTextNode(' of ')); addField('page-count')
    } else addField('page-number')
    if (insertAtCaret && range) {
      range.deleteContents(); range.insertNode(fragment); range.collapse(false); selection?.removeAllRanges(); selection?.addRange(range)
    } else element.append(fragment)
    element.focus()
  }
  const focusBlankPaper = (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (event.currentTarget.classList.contains('editor-page-wrap') && target === event.currentTarget) {
      event.preventDefault()
      return
    }
    if (target.closest('.soflo-editor, .document-title, button, input, textarea, a, .paper-running-header, .paper-running-footer')) return
    event.preventDefault()
    if (!editor.getText().trim()) editor.chain().focus('end').run()
  }
  const beginRunningEdit = (region: RunningRegion, page: number, element: HTMLElement, x: number, y: number) => {
    const value = runningTextForPage(region === 'header' ? headerPages : footerPages, region === 'header' ? headerText : footerText, region === 'header' ? repeatHeader : repeatFooter, page)
    setRunningFieldMarkup(element, value, page, pageCount)
    element.contentEditable = 'true'
    activeRunningElementRef.current = element
    setEditingRegion({ region, page, x, y })
    window.requestAnimationFrame(() => element.focus())
  }
  const runningRegion = (region: RunningRegion) => {
    const value = runningTextForPage(region === 'header' ? headerPages : footerPages, region === 'header' ? headerText : footerText, region === 'header' ? repeatHeader : repeatFooter, 1)
    const active = editingRegion?.region === region && editingRegion.page === 1
    const Ref = region === 'header' ? headerRef : footerRef
    return <div ref={Ref} className={`paper-running-${region}${active && !versionHistoryOpen ? ' editing' : ''}${value || active ? '' : ' empty'}`} contentEditable={active && !versionHistoryOpen} suppressContentEditableWarning onDoubleClick={(event) => { if (versionHistoryOpen) return; event.preventDefault(); event.stopPropagation(); beginRunningEdit(region, 1, event.currentTarget, event.clientX, event.clientY) }} onBlur={(event) => { if (!versionHistoryOpen) saveRunningRegion(region, 1, serializeRunningRegion(event.currentTarget)) }} />
  }
  const renderVersionEntry = (entry: RevisionHistoryEntry, nested = false) => {
    const index = historyTimeline.findIndex((candidate) => candidate.id === entry.id)
    const older = historyTimeline[index + 1]
    const selected = entry.id === versionHistorySelectedId
    return <div className={`version-entry${selected ? ' selected' : ''}${nested ? ' nested' : ''}`} key={entry.id}><button className="version-entry-main" onClick={() => setVersionHistorySelectedId(entry.id)}><i /><span><strong>{entry.id === 'current' ? 'Current version' : entry.name || revisionTimeOnly(entry.createdAt)}</strong><small>{entry.id === 'current' ? 'Latest saved work' : revisionSummary(entry, older)}</small>{entry.name && <time>{revisionTimeOnly(entry.createdAt)}</time>}</span></button>{entry.id !== 'current' && <button className="version-name-button" aria-label={`Name version ${entry.revision}`} onClick={() => { setNamingVersionId(entry.id); setVersionName(entry.name ?? '') }}><Pencil size={12} /></button>}{namingVersionId === entry.id && <form className="version-name-form" onSubmit={(event) => { event.preventDefault(); void saveVersionName(entry) }}><input autoFocus value={versionName} onChange={(event) => setVersionName(event.target.value)} placeholder="e.g. First Draft" /><button type="submit"><Check size={12} /></button><button type="button" onClick={() => setNamingVersionId(null)}><X size={12} /></button></form>}</div>
  }
  const panelStyle = (position: WritingPanelPosition | null, zIndex: number) => position ? { left: `${position.left}px`, top: `${position.top}px`, right: 'auto', bottom: 'auto', zIndex } : { zIndex }
  const writingPanelStyle = {
    zIndex: 100 + pinnedWritingPanels.length,
    '--soflo-grammar-panel-left': grammarPanelPosition ? `${grammarPanelPosition.left}px` : undefined,
    '--soflo-grammar-panel-top': grammarPanelPosition ? `${grammarPanelPosition.top}px` : undefined,
    '--soflo-word-panel-left': wordReferencePanelPosition ? `${wordReferencePanelPosition.left}px` : undefined,
    '--soflo-word-panel-top': wordReferencePanelPosition ? `${wordReferencePanelPosition.top}px` : undefined,
  } as CSSProperties
  const thesaurusPanelStyle = panelStyle(thesaurusPanelPosition, 88)
  const researchPanelStyle = panelStyle(researchPanelPosition, 88)
  const writingPanelControls = (onClose: () => void) => {
    const grammarPanel = onClose === closeActiveGrammarPanel
    const pinned = grammarPanel ? grammarPanelPinned : wordReferencePinned
    const togglePin = () => {
      const next = !pinned
      if (grammarPanel) { grammarPanelPinnedRef.current = next; setGrammarPanelPinned(next) }
      else { wordReferencePinnedRef.current = next; setWordReferencePinned(next) }
    }
    return <div className="writing-panel-controls"><button type="button" className={pinned ? 'icon-button tiny active' : 'icon-button tiny'} onClick={togglePin} aria-label={pinned ? 'Unpin this panel' : 'Keep this panel open'} aria-pressed={pinned}><Pin size={14} /></button><button type="button" className="icon-button tiny" onClick={onClose} aria-label="Close panel"><X size={16} /></button></div>
  }
  const pinnedPanelControls = (panel: PinnedWritingPanel) => <div className="writing-panel-controls"><button type="button" className={panel.pinned ? 'icon-button tiny active' : 'icon-button tiny'} onClick={() => setPinnedWritingPanels((panels) => panels.map((current) => current.id === panel.id ? { ...current, pinned: !current.pinned } : current))} aria-label={panel.pinned ? 'Unpin this panel' : 'Pin this panel'} aria-pressed={panel.pinned}><Pin size={14} /></button><button type="button" className="icon-button tiny" onClick={() => setPinnedWritingPanels((panels) => panels.filter((current) => current.id !== panel.id))} aria-label="Close panel"><X size={16} /></button></div>
  const renderPinnedWritingPanel = (panel: PinnedWritingPanel, index: number) => panel.kind === 'grammar' && panel.issue
    ? <aside key={panel.id} data-pinned-panel-id={panel.id} className="grammar-sidebar writing-floating-panel pinned-writing-panel" style={panelStyle(panel.position, 80 + index)} aria-label="Pinned writing suggestion"><header onPointerDown={(event) => beginWritingPanelDrag(event, (position) => setPinnedWritingPanels((panels) => panels.map((current) => current.id === panel.id ? { ...current, position } : current)))}><div><p className="eyebrow">PINNED WRITING SUGGESTION</p><h2>{panel.issue.kind === 'style' ? 'Formal rewrite' : panel.issue.kind === 'structure' ? 'Flow suggestion' : 'Suggestion'}</h2></div>{pinnedPanelControls(panel)}</header><div className="grammar-suggestion-detail"><small>{panel.issue.category}{panel.issue.partOfSpeech ? ` · ${panel.issue.partOfSpeech}` : ''}</small><p className="grammar-change"><s>{panel.issue.original}</s><strong>{panel.issue.replacement}</strong></p><section><h3>{panel.issue.kind === 'style' ? 'Why this is better' : panel.issue.kind === 'structure' ? 'Suggested flow' : 'What to fix'}</h3><p>{panel.issue.reason}</p></section></div></aside>
    : <aside key={panel.id} data-pinned-panel-id={panel.id} className="word-reference-sidebar writing-floating-panel pinned-writing-panel" style={panelStyle(panel.position, 80 + index)} aria-label="Pinned word reference"><header onPointerDown={(event) => beginWritingPanelDrag(event, (position) => setPinnedWritingPanels((panels) => panels.map((current) => current.id === panel.id ? { ...current, position } : current)))}><div><p className="eyebrow">PINNED WORD REFERENCE</p><h2>{panel.reference?.word || panel.word}</h2>{panel.reference?.pronunciation && <span>{panel.reference.pronunciation}</span>}</div>{pinnedPanelControls(panel)}</header><div className="word-reference-detail">{panel.error && <p className="word-reference-error">{panel.error}</p>}{panel.reference?.senses.map((sense, senseIndex) => <section key={`${sense.partOfSpeech}-${senseIndex}`}><h3>{sense.partOfSpeech || 'Definition'}</h3><p><b>{senseIndex + 1}.</b>{sense.definition}</p>{sense.example && <em>“{sense.example}”</em>}</section>)}{panel.reference && <section><h3>Formal related words</h3><div className="grammar-synonyms word-reference-synonyms">{panel.reference.synonyms.map((synonym) => <span key={synonym}>{synonym}</span>)}</div></section>}</div></aside>
  return <main className={`editor-view${versionHistoryOpen ? ' version-history-mode' : ''}`}>
    {versionHistoryOpen ? <header className="history-mode-topbar"><div><p className="eyebrow">{collectionLabel === 'Lectures' ? 'LECTURE HISTORY' : 'PAPER HISTORY'}</p><h1>Version history</h1><span>{selectedHistoryEntry.id === 'current' ? 'Current version' : selectedHistoryEntry.name || revisionTimeOnly(selectedHistoryEntry.createdAt)}</span></div><div><button className="button button-quiet" disabled={selectedHistoryEntry.id === 'current' || versionRestoring} onClick={() => void restoreSelectedVersion()}><RotateCcw size={15} />{versionRestoring ? 'Restoring…' : 'Restore this version'}</button><button className="button button-primary" onClick={closeVersionHistory}><Check size={15} />Done</button></div></header> : <header className="editor-topbar">
      <div className="editor-breadcrumb"><button className="editor-breadcrumb-link" onClick={onBack}><FileText size={15} />{collectionLabel}</button><span className="breadcrumb-separator">/</span><span>{document.title || 'Untitled paper'}</span>{context && <small className="editor-context">{context}</small>}</div>
      <div className={`save-indicator ${saveState}`}>{passiveGrammarReviewing ? <><RefreshCw className="passive-grammar-refresh" size={13} /><em>Checking</em></> : <><span />{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Couldn’t save' : 'Saved'}</>}</div>
      <div className="editor-actions">{onDuplicate && <button className="editor-action" onClick={onDuplicate}>Duplicate</button>}<button className="editor-action danger" onClick={onDelete}>{deleteLabel}</button></div>
    </header>}
    {!versionHistoryOpen && <div className="editor-toolbar-wrap">
    <EditorToolbar editor={editor} spellcheck={spellcheck} aiEnabled={aiEnabled} aiGrammarEnabled={aiGrammarEnabled} grammarReviewing={grammarReviewing} researchReviewing={researchReviewing} onSpellcheckChange={onSpellcheckChange} onAiGrammarEnabledChange={onAiGrammarEnabledChange} onGrammarReview={() => void reviewGrammar(false)} onResearchAndGrade={() => void runResearchAndGrade()} onAiThesaurus={openThesaurus} onPaperContext={openPaperContext} onVersionHistory={() => void openVersionHistory()} onExportPdf={exportPdf} onExportDocx={() => void exportDocx()} onImportPdf={() => void importPdf()} onFind={() => window.dispatchEvent(new Event('soflo:open-find'))} onOpenLinkDialog={openLinkDialog} onOpenImageDialog={() => setImageDialog({ src: '' })} onOpenTableDialog={() => setTableDialog({ rows: 3, cols: 3, withHeaderRow: true })} />
    </div>}
    {editingRegion && <div className="header-footer-context-menu" role="menu" aria-label={`${editingRegion.region === 'header' ? 'Header' : 'Footer'} tools`} style={{ left: Math.min(editingRegion.x, window.innerWidth - 228), top: Math.min(editingRegion.y + 10, window.innerHeight - 174) }} onMouseDown={(event) => event.preventDefault()}><span>{editingRegion.region === 'header' ? `Header · page ${editingRegion.page}` : `Footer · page ${editingRegion.page}`}</span><button type="button" onClick={() => insertRunningField('page-number')}>Insert page number</button><button type="button" onClick={() => insertRunningField('page-x-of-y')}>Insert Page X of Y</button><button type="button" className={(editingRegion.region === 'header' ? repeatHeader : repeatFooter) ? 'active' : ''} onClick={toggleRunningRepeat}>{(editingRegion.region === 'header' ? repeatHeader : repeatFooter) ? 'Edit each page separately' : 'Make same on every page'}</button></div>}
    {findOpen && <div className="find-bar"><Search size={15} /><input id="find-input" value={findValue} onChange={(event) => runFind(event.target.value)} placeholder="Find in document" /><span>{findValue ? 'Use Enter to find next' : ''}</span><button className="icon-button tiny" onClick={() => setFindOpen(false)} aria-label="Close find">×</button></div>}
    <section className="editor-page-wrap" onMouseDown={focusBlankPaper}><article className={`document-page reading-${readingSurface} page-margin-${pageMargin} page-line-${lineSpacing} has-running-header has-running-footer`} data-running-header={headerText} data-running-footer={footerText} data-running-header-pages={JSON.stringify(headerPages)} data-running-footer-pages={JSON.stringify(footerPages)} data-repeat-header={repeatHeader} data-repeat-footer={repeatFooter} data-show-page-numbers={showPageNumbers} onMouseDown={focusBlankPaper}>{runningRegion('header')}<EditorContent editor={editor} onContextMenu={openContextMenu} />{runningRegion('footer')}</article>{grammarOpen && selectedGrammarIssue && <aside className="grammar-sidebar" aria-label="Writing suggestion"><header><div><p className="eyebrow">{selectedGrammarIssue.kind === 'style' ? 'FORMAL WRITING' : selectedGrammarIssue.kind === 'structure' ? 'FLOW & STRUCTURE' : 'SPELLING & WRITING'}</p><h2>{selectedGrammarIssue.kind === 'style' ? 'Formal rewrite' : selectedGrammarIssue.kind === 'structure' ? 'Flow suggestion' : 'Suggestion'}</h2></div><button className="icon-button tiny" onClick={() => { setGrammarOpen(false); setSelectedGrammarIssue(null) }} aria-label="Close writing suggestion"><X size={16} /></button></header><div className="grammar-suggestion-detail"><small>{selectedGrammarIssue.category}{selectedGrammarIssue.partOfSpeech ? ` · ${selectedGrammarIssue.partOfSpeech}` : ''}</small><p className="grammar-change"><s>{selectedGrammarIssue.original}</s><strong>{selectedGrammarIssue.replacement}</strong></p>{selectedGrammarIssue.kind !== 'structure' && selectedGrammarIssue.alternatives.length > 0 && <section><h3>{selectedGrammarIssue.kind === 'style' ? 'Choose a rewrite' : 'Choose a correction'}</h3><div className="grammar-alternatives">{selectedGrammarIssue.alternatives.map((alternative) => <button key={alternative} onClick={() => applyGrammarIssue(selectedGrammarIssue, alternative)}>{alternative}</button>)}</div></section>}<section><h3>{selectedGrammarIssue.kind === 'style' ? 'Why this is better' : selectedGrammarIssue.kind === 'structure' ? 'Suggested flow' : 'What to fix'}</h3><p>{selectedGrammarIssue.reason}</p></section>{selectedGrammarIssue.definition && <section><h3>Definition</h3><p>{selectedGrammarIssue.definition}</p></section>}{selectedGrammarIssue.useCase && <section><h3>When to use it</h3><p>{selectedGrammarIssue.useCase}</p></section>}{selectedGrammarIssue.synonyms.length > 0 && <section><h3>Related words</h3><div className="grammar-synonyms">{selectedGrammarIssue.synonyms.map((synonym) => <span key={synonym}>{synonym}</span>)}</div></section>}{selectedGrammarIssue.kind === 'structure' ? <p className="grammar-structure-note">This is a flow recommendation; move the paragraph yourself if it fits your argument.</p> : <div className="grammar-suggestion-actions"><button className="button button-quiet button-small" onClick={() => ignoreGrammarIssue(selectedGrammarIssue)}>Ignore</button><button className="button button-primary button-small" onClick={() => applyGrammarIssue(selectedGrammarIssue)}>Replace text</button></div>}</div></aside>}{(wordReferenceLoading || wordReference || wordReferenceError) && <aside className="word-reference-sidebar" aria-label="Word reference"><header><div><p className="eyebrow">WORD REFERENCE</p><h2>{wordReference?.word || selectedWordReferenceRef.current}</h2>{wordReference?.pronunciation && <span>{wordReference.pronunciation}</span>}</div><button className="icon-button tiny" onClick={() => { wordReferenceRequestRef.current += 1; selectedWordReferenceRef.current = ''; setWordReference(null); setWordReferenceLoading(false); setWordReferenceError('') }} aria-label="Close word reference"><X size={16} /></button></header><div className="word-reference-detail">{wordReferenceLoading && <div className="word-reference-loading"><i />Looking up this word locally…</div>}{wordReferenceError && <p className="word-reference-error">{wordReferenceError}</p>}{wordReference?.senses.map((sense, index) => <section key={`${sense.partOfSpeech}-${index}`}><h3>{sense.partOfSpeech || 'Definition'}</h3><p><b>{index + 1}.</b>{sense.definition}</p>{sense.example && <em>“{sense.example}”</em>}</section>)}{wordReference && <section><h3>Formal related words</h3><div className="grammar-synonyms word-reference-synonyms">{wordReference.synonyms.map((synonym) => <span key={synonym}>{synonym}</span>)}</div></section>}</div></aside>}{thesaurusOpen && <aside className="word-reference-sidebar thesaurus-sidebar" aria-label="AI Thesaurus"><header><div><p className="eyebrow">AI WRITING TOOL</p><h2>AI Thesaurus</h2><span>Grouped by closeness</span></div><button className="icon-button tiny" onClick={() => { setThesaurusOpen(false); setThesaurusResult(null); setThesaurusError('') }} aria-label="Close AI thesaurus"><X size={16} /></button></header><form className="thesaurus-form" onSubmit={(event) => void runThesaurus(event)}><label htmlFor="thesaurus-query">What kind of word are you looking for?</label><div><input id="thesaurus-query" value={thesaurusQuery} onChange={(event) => setThesaurusQuery(event.target.value)} placeholder="e.g. important, explain, difficult" autoFocus /><button className="button button-primary button-small" type="submit" disabled={!thesaurusQuery.trim() || thesaurusLoading}>{thesaurusLoading ? 'Finding…' : 'Find words'}</button></div></form>{thesaurusError && <p className="word-reference-error thesaurus-error">{thesaurusError}</p>}{thesaurusLoading && <div className="word-reference-loading"><i />Finding grouped alternatives locally…</div>}{thesaurusResult && <div className="thesaurus-detail"><p className="thesaurus-query">For <strong>{thesaurusResult.query}</strong></p>{[['Closest matches', thesaurusResult.close], ['Related / formal', thesaurusResult.related], ['Broader alternatives', thesaurusResult.broad]].map(([label, words]) => Array.isArray(words) && words.length > 0 && <section key={String(label)}><h3>{String(label)}</h3><div className="grammar-synonyms">{words.map((word) => <span key={word}>{word}</span>)}</div></section>)}</div>}</aside>}</section>
    {sidePanel && <aside className="lecture-recording-slot" aria-label="Lecture recording">{sidePanel}</aside>}
    {pinnedWritingPanels.map(renderPinnedWritingPanel)}
    {grammarOpen && selectedGrammarIssue && <aside className="grammar-sidebar writing-floating-panel" style={writingPanelStyle} aria-label="Writing suggestion"><header onPointerDown={beginWritingPanelDrag}><div><p className="eyebrow">{selectedGrammarIssue.kind === 'style' ? 'FORMAL WRITING' : selectedGrammarIssue.kind === 'structure' ? 'FLOW & STRUCTURE' : 'SPELLING & WRITING'}</p><h2>{selectedGrammarIssue.kind === 'style' ? 'Formal rewrite' : selectedGrammarIssue.kind === 'structure' ? 'Flow suggestion' : 'Suggestion'}</h2></div>{writingPanelControls(closeActiveGrammarPanel)}</header><div className="grammar-suggestion-detail"><small>{selectedGrammarIssue.category}{selectedGrammarIssue.partOfSpeech ? ` · ${selectedGrammarIssue.partOfSpeech}` : ''}</small><p className="grammar-change"><s>{selectedGrammarIssue.original}</s><strong>{selectedGrammarIssue.replacement}</strong></p>{selectedGrammarIssue.kind !== 'structure' && selectedGrammarIssue.alternatives.length > 0 && <section><h3>{selectedGrammarIssue.kind === 'style' ? 'Choose a rewrite' : 'Choose a correction'}</h3><div className="grammar-alternatives">{selectedGrammarIssue.alternatives.map((alternative) => <button key={alternative} onClick={() => applyGrammarIssue(selectedGrammarIssue, alternative)}>{alternative}</button>)}</div></section>}<section><h3>{selectedGrammarIssue.kind === 'style' ? 'Why this is better' : selectedGrammarIssue.kind === 'structure' ? 'Suggested flow' : 'What to fix'}</h3><p>{selectedGrammarIssue.reason}</p></section>{selectedGrammarIssue.definition && <section><h3>Definition</h3><p>{selectedGrammarIssue.definition}</p></section>}{selectedGrammarIssue.useCase && <section><h3>When to use it</h3><p>{selectedGrammarIssue.useCase}</p></section>}{selectedGrammarIssue.synonyms.length > 0 && <section><h3>Related words</h3><div className="grammar-synonyms">{selectedGrammarIssue.synonyms.map((synonym) => <span key={synonym}>{synonym}</span>)}</div></section>}{selectedGrammarIssue.kind === 'structure' ? <p className="grammar-structure-note">This is a flow recommendation; move the paragraph yourself if it fits your argument.</p> : <div className="grammar-suggestion-actions"><button className="button button-quiet button-small" onClick={() => ignoreGrammarIssue(selectedGrammarIssue)}>Ignore</button><button className="button button-primary button-small" onClick={() => applyGrammarIssue(selectedGrammarIssue)}>Replace text</button></div>}</div></aside>}
    {(wordReferenceLoading || wordReference || wordReferenceError) && <aside className="word-reference-sidebar writing-floating-panel" style={writingPanelStyle} aria-label="Word reference"><header onPointerDown={beginWritingPanelDrag}><div><p className="eyebrow">WORD REFERENCE</p><h2>{wordReference?.word || selectedWordReferenceRef.current}</h2>{wordReference?.pronunciation && <span>{wordReference.pronunciation}</span>}</div>{writingPanelControls(closeWordReference)}</header><div className="word-reference-detail">{wordReferenceLoading && <div className="word-reference-loading"><i />Looking up this word locally…</div>}{wordReferenceError && <p className="word-reference-error">{wordReferenceError}</p>}{wordReference?.senses.map((sense, index) => <section key={`${sense.partOfSpeech}-${index}`}><h3>{sense.partOfSpeech || 'Definition'}</h3><p><b>{index + 1}.</b>{sense.definition}</p>{sense.example && <em>“{sense.example}”</em>}</section>)}{wordReference && <section><h3>Formal related words</h3><div className="grammar-synonyms word-reference-synonyms">{wordReference.synonyms.map((synonym) => <button type="button" key={synonym} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); useWordAlternative(synonym) }} onClick={(event) => { event.preventDefault(); event.stopPropagation() }}>{synonym}</button>)}</div></section>}</div></aside>}
    {thesaurusOpen && <aside className="word-reference-sidebar thesaurus-sidebar writing-floating-panel" style={thesaurusPanelStyle} aria-label="AI Thesaurus"><header onPointerDown={(event) => beginWritingPanelDrag(event, setThesaurusPanelPosition)}><div><p className="eyebrow">AI WRITING TOOL</p><h2>AI Thesaurus</h2><span>Find language that fits this paper.</span></div><button type="button" className="icon-button tiny" onClick={() => { setThesaurusOpen(false); setThesaurusResult(null); setThesaurusError('') }} aria-label="Close AI thesaurus"><X size={16} /></button></header><form className="thesaurus-form" onSubmit={(event) => void runThesaurus(event)}><label htmlFor="thesaurus-query">What kind of word are you looking for?</label><div><input id="thesaurus-query" value={thesaurusQuery} onChange={(event) => setThesaurusQuery(event.target.value)} placeholder="e.g. important, explain, difficult" autoFocus /><button className="button button-primary button-small" type="submit" disabled={!thesaurusQuery.trim() || thesaurusLoading}>{thesaurusLoading ? 'Finding…' : 'Find words'}</button></div></form>{thesaurusError && <p className="word-reference-error thesaurus-error">{thesaurusError}</p>}{thesaurusLoading && <div className="word-reference-loading thesaurus-loading"><i />Finding words that fit…</div>}{thesaurusResult && <div className="thesaurus-detail"><p className="thesaurus-query">For <strong>{thesaurusResult.query}</strong></p>{[['Closest matches', thesaurusResult.close], ['Related / formal', thesaurusResult.related], ['Broader alternatives', thesaurusResult.broad]].map(([label, words]) => Array.isArray(words) && words.length > 0 && <section key={String(label)}><h3>{String(label)}</h3><div className="grammar-synonyms">{words.map((word) => <span key={word}>{word}</span>)}</div></section>)}</div>}</aside>}
    {researchGrade && <aside className="research-grade-sidebar writing-floating-panel" style={researchPanelStyle} aria-label="AI research and grade"><header onPointerDown={(event) => beginWritingPanelDrag(event, setResearchPanelPosition)}><div><p className="eyebrow">AI RESEARCH & GRADE</p><h2>Approx. {researchGrade.grade || '—'}</h2></div><button className="icon-button tiny" onClick={() => setResearchGrade(null)} aria-label="Close research and grade"><X size={16} /></button></header><div className="research-grade-detail">{researchGrade.overview && <p className="research-overview">{researchGrade.overview}</p>}{researchGrade.researchQuery && <small className="research-query">Research topic: {researchGrade.researchQuery}</small>}{researchGrade.strengths.length > 0 && <section><h3>What is working</h3><ul>{researchGrade.strengths.map((item) => <li key={item}>{item}</li>)}</ul></section>}{researchGrade.improvements.length > 0 && <section><h3>Most important next steps</h3><ul>{researchGrade.improvements.map((item) => <li key={item}>{item}</li>)}</ul></section>}{researchGrade.evidence && <section><h3>Evidence</h3><p>{researchGrade.evidence}</p></section>}{researchGrade.reasoning && <section><h3>Reasoning</h3><p>{researchGrade.reasoning}</p></section>}{Object.entries(researchGrade.writingCraft).length > 0 && <section><h3>Writing craft</h3><dl>{Object.entries(researchGrade.writingCraft).map(([label, detail]) => <div key={label}><dt>{label.replace(/([A-Z])/g, ' $1')}</dt><dd>{detail}</dd></div>)}</dl></section>}{researchGrade.researchAdvice.length > 0 && <section><h3>Research direction</h3><ul>{researchGrade.researchAdvice.map((item) => <li key={item}>{item}</li>)}</ul></section>}{researchGrade.sources.length > 0 && <section><h3>Scholarly research leads</h3><div className="research-source-list">{researchGrade.sources.map((source) => <button key={source.url} onClick={() => openExternalLink(source.url)}><strong>{source.title}</strong><span>{[source.publication, source.year, source.type].filter(Boolean).join(' · ')}</span></button>)}</div>{researchGrade.sourceNote && <small>{researchGrade.sourceNote}</small>}</section>}</div></aside>}
    {researchReviewing && <div className="grammar-review-notice research-review-notice" role="status" aria-live="polite"><i /><div><strong>Researching and grading your paper</strong><span>{grammarProgress?.message || 'Finding scholarly research leads and reviewing your evidence locally.'}</span></div><small>{grammarProgress ? `${grammarProgress.progress}%` : '…'}</small></div>}
    {researchError && <div className="grammar-review-notice grammar-review-error" role="status"><div><strong>Research & Grade needs another pass</strong><span>{researchError}</span></div><button className="icon-button tiny" onClick={() => setResearchError('')} aria-label="Dismiss research and grade message"><X size={15} /></button></div>}
    {grammarReviewing && <div className="grammar-review-notice" role="status" aria-live="polite"><i /><div><strong>Checking your writing</strong><span>{grammarProgress?.message || 'Reviewing spelling and grammar locally.'}</span></div><small>{grammarProgress ? `${grammarProgress.progress}%` : '…'}</small></div>}
    {grammarMessage && <div className="grammar-review-notice grammar-review-error" role="status"><div><strong>AI Review needs another pass</strong><span>{grammarMessage}</span></div><button className="icon-button tiny" onClick={() => setGrammarMessage('')} aria-label="Dismiss grammar review message"><X size={15} /></button></div>}
    {linkPreview && <aside className="editor-link-preview" style={{ left: linkPreview.x, top: linkPreview.y }} aria-label="Link destination"><div><small>LINK DESTINATION</small><strong title={linkPreview.href}>{linkPreview.label}</strong><span title={linkPreview.href}>{linkPreview.href}</span></div><button className="button button-primary button-small" onClick={() => { openExternalLink(linkPreview.href); setActiveLinkPreview(null) }}>Open</button><button className="icon-button tiny" onClick={() => setActiveLinkPreview(null)} aria-label="Close link preview"><X size={15} /></button></aside>}
    {versionHistoryOpen && <aside className="version-history-sidebar" aria-label="Version history"><header><p className="eyebrow">VERSION HISTORY</p><h2>{collectionLabel === 'Lectures' ? 'Lecture timeline' : 'Paper timeline'}</h2><span>Select a checkpoint to view the real document.</span></header>{versionHistoryLoading && <div className="version-history-loading"><div className="word-reference-loading"><i />Loading saved versions…</div></div>}{versionHistoryError && <p className="word-reference-error version-history-error">{versionHistoryError}</p>}{!versionHistoryLoading && <nav className="version-history-timeline" aria-label="Saved versions">{historyDays.map((day) => <section key={day.label}><h3>{day.label}</h3>{day.clusters.map((cluster) => cluster.entries.length === 1 ? renderVersionEntry(cluster.entries[0]) : <div className="version-cluster" key={cluster.id}><button className="version-cluster-toggle" onClick={() => setExpandedVersionGroups((current) => { const next = new Set(current); if (next.has(cluster.id)) next.delete(cluster.id); else next.add(cluster.id); return next })}><ChevronDown className={expandedVersionGroups.has(cluster.id) ? 'expanded' : ''} size={13} /><span><strong>{revisionTimeOnly(cluster.entries[0].createdAt)}</strong><small>{cluster.entries.length} versions</small></span></button>{expandedVersionGroups.has(cluster.id) && <div className="version-cluster-members">{cluster.entries.map((entry) => renderVersionEntry(entry, true))}</div>}</div>)}</section>)}{versionHistory.length === 0 && <p className="version-history-empty">Your first meaningful checkpoint will appear after another editing session.</p>}</nav>}<footer><span><i className="history-added-key" />Added</span><span><i className="history-removed-key" />Removed</span><small>Changes appear directly on the paper.</small></footer></aside>}
    {contextMenu && <div className="editor-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" aria-label="Paper editing menu"><ContextMenuAction label="Undo" shortcut="Ctrl Z" disabled={!editor.can().undo()} onClick={() => void runContextAction('undo')} /><ContextMenuAction label="Redo" shortcut="Ctrl Shift Z" disabled={!editor.can().redo()} onClick={() => void runContextAction('redo')} /><hr /><ContextMenuAction label="Cut" shortcut="Ctrl X" disabled={editor.state.selection.empty} onClick={() => void runContextAction('cut')} /><ContextMenuAction label="Copy" shortcut="Ctrl C" disabled={editor.state.selection.empty} onClick={() => void runContextAction('copy')} /><ContextMenuAction label="Paste" shortcut="Ctrl V" onClick={() => void runContextAction('paste')} /><hr /><ContextMenuAction label="Select all" shortcut="Ctrl A" onClick={() => void runContextAction('selectAll')} /><hr /><ContextMenuAction label="Insert" shortcut="›" onClick={() => setContextSubmenu(contextSubmenu === 'insert' ? null : 'insert')} />{contextSubmenu === 'insert' && <div className="editor-context-submenu" role="menu" aria-label="Insert menu"><ContextMenuAction label="Citation" shortcut="›" onClick={() => window.dispatchEvent(new Event('soflo:open-citation'))} /></div>}</div>}
    {citationMenuOpen && contextMenu && <div className="editor-context-menu citation-menu" style={{ left: contextMenu.x + 205, top: contextMenu.y + 38 }} role="menu" aria-label="Citation styles"><ContextMenuAction label="MLA" shortcut="" onClick={() => insertCitation('mla')} /><ContextMenuAction label="APA" shortcut="" onClick={() => insertCitation('apa')} /><ContextMenuAction label="Chicago" shortcut="" onClick={() => insertCitation('chicago')} /></div>}
    {paperContextOpen && <PaperContextDialog value={paperContextDraft} onChange={setPaperContextDraft} onClose={() => setPaperContextOpen(false)} onReset={() => setPaperContextDraft(defaultPaperContext)} onSave={savePaperContext} />}
    {linkDialog && <LinkDialog initialUrl={linkDialog.url} canRemove={linkDialog.canRemove} onClose={() => setLinkDialog(null)} onApply={applyLink} onRemove={() => { editor.chain().focus().unsetLink().run(); setLinkDialog(null) }} />}
    {imageDialog && <ImageDialog source={imageDialog.src} onClose={() => setImageDialog(null)} onSourceChange={(src) => setImageDialog({ src })} onInsert={insertImage} />}
    {tableDialog && <TableDialog table={tableDialog} onClose={() => setTableDialog(null)} onChange={setTableDialog} onInsert={insertTable} />}
    {!versionHistoryOpen && <button className="page-settings-button" aria-label="Page settings" title="Page settings" onClick={() => setPageSettingsOpen((open) => !open)}><Settings2 size={20} /></button>}
    {!versionHistoryOpen && pageSettingsOpen && <aside className="page-settings-panel" aria-label="Page settings"><header><div><p className="eyebrow">DOCUMENT</p><h2>Page settings</h2></div><button className="icon-button" onClick={() => setPageSettingsOpen(false)} aria-label="Close page settings"><X size={18} /></button></header><div className="page-settings-content"><div className="paper-spec"><span>US</span><div><strong>US Letter</strong><small>8.5 × 11 in · Google Docs baseline</small></div></div><fieldset><legend>Margins</legend><div className="segmented-control">{(['narrow', 'normal', 'wide'] as const).map((option) => <button key={option} className={pageMargin === option ? 'active' : ''} onClick={() => setPageMargin(option)}>{option}</button>)}</div></fieldset><fieldset><legend>Line spacing</legend><div className="segmented-control segmented-control-four">{([['single', '1.0'], ['docs', '1.15'], ['one-half', '1.5'], ['double', '2.0']] as const).map(([option, label]) => <button key={option} className={lineSpacing === option ? 'active' : ''} onClick={() => setLineSpacing(option)}>{label}</button>)}</div></fieldset><p className="page-settings-note">Normal margins, 11 pt Arial, black text, and 1.15 line spacing are the default.</p>{pdfMessage && <p className="page-settings-message">{pdfMessage}</p>}</div></aside>}
    {paperZoomVisible && !versionHistoryOpen && <button type="button" className="paper-zoom-indicator" onClick={resetPaperZoom} title="Reset page zoom">{paperZoom}% <span>Reset</span></button>}
  </main>
}

function LinkDialog({ initialUrl, canRemove, onClose, onApply, onRemove }: { initialUrl: string; canRemove: boolean; onClose: () => void; onApply: (url: string) => void; onRemove: () => void }) {
  const [url, setUrl] = useState(initialUrl)
  return <div className="editor-dialog-backdrop" role="presentation"><form className="editor-dialog" aria-label="Add or edit link" onSubmit={(event) => { event.preventDefault(); onApply(url) }}><header><div><p className="eyebrow">LINK</p><h2>{canRemove ? 'Edit link' : 'Add link'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close link dialog"><X size={18} /></button></header><div className="editor-dialog-content"><label>Web address<input type="url" autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" inputMode="url" /></label><p>Highlight text first, then apply a link to it.</p></div><footer>{canRemove && <button type="button" className="button button-danger button-small" onClick={onRemove}>Remove link</button>}<span /><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!url.trim()}>Apply link</button></footer></form></div>
}

function PaperContextDialog({ value, onChange, onClose, onReset, onSave }: { value: string; onChange: (value: string) => void; onClose: () => void; onReset: () => void; onSave: () => void }) {
  return <div className="editor-dialog-backdrop" role="presentation"><form className="editor-dialog paper-context-dialog" aria-label="AI Paper Context" onSubmit={(event) => { event.preventDefault(); onSave() }}><header><div><p className="eyebrow">AI WRITING</p><h2>AI Paper Context</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close AI Paper Context"><X size={18} /></button></header><div className="editor-dialog-content"><label>What would you like the AI to know about what this document is trying to achieve?<textarea autoFocus rows={7} value={value} onChange={(event) => onChange(event.target.value)} placeholder={defaultPaperContext} /></label><p>SoFlo uses this context when it reviews, grades, defines, and suggests language for this document.</p></div><footer><button type="button" className="button button-quiet" onClick={onReset}>Reset to default</button><span /><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary">Save context</button></footer></form></div>
}

function ImageDialog({ source, onClose, onSourceChange, onInsert }: { source: string; onClose: () => void; onSourceChange: (source: string) => void; onInsert: (source: string) => void }) {
  const chooseFile = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') onSourceChange(reader.result) }
    reader.readAsDataURL(file)
  }
  return <div className="editor-dialog-backdrop" role="presentation"><form className="editor-dialog" aria-label="Add image" onSubmit={(event) => { event.preventDefault(); onInsert(source) }}><header><div><p className="eyebrow">IMAGE</p><h2>Add an image</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close image dialog"><X size={18} /></button></header><div className="editor-dialog-content"><label>Image URL<input type="url" autoFocus value={source.startsWith('data:') ? '' : source} onChange={(event) => onSourceChange(event.target.value)} placeholder="https://example.com/image.png" inputMode="url" /></label><div className="image-file-picker"><span>or</span><label className="button button-quiet button-small"><ImagePlus size={15} /> Choose image file<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif,image/bmp,image/tiff,image/heic,image/heif" onChange={(event) => chooseFile(event.currentTarget.files?.[0])} /></label></div>{source && <div className="image-preview"><img src={source} alt="Selected image preview" /></div>}</div><footer><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!source.trim()}>Insert image</button></footer></form></div>
}

function TableDialog({ table, onClose, onChange, onInsert }: { table: { rows: number; cols: number; withHeaderRow: boolean }; onClose: () => void; onChange: (table: { rows: number; cols: number; withHeaderRow: boolean }) => void; onInsert: (table: { rows: number; cols: number; withHeaderRow: boolean }) => void }) {
  const setDimension = (key: 'rows' | 'cols', value: number) => onChange({ ...table, [key]: Math.max(1, Math.min(20, Number.isFinite(value) ? value : 1)) })
  return <div className="editor-dialog-backdrop" role="presentation"><form className="editor-dialog table-dialog" aria-label="Insert table" onSubmit={(event) => { event.preventDefault(); onInsert(table) }}><header><div><p className="eyebrow">TABLE</p><h2>Insert table</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close table dialog"><X size={18} /></button></header><div className="editor-dialog-content"><div className="table-size-fields"><label>Columns<input type="number" min="1" max="20" value={table.cols} onChange={(event) => setDimension('cols', Number(event.target.value))} /></label><span>×</span><label>Rows<input type="number" min="1" max="20" value={table.rows} onChange={(event) => setDimension('rows', Number(event.target.value))} /></label></div><div className="table-preview" style={{ gridTemplateColumns: `repeat(${table.cols}, 1fr)` }} aria-label={`${table.rows} by ${table.cols} table preview`}>{Array.from({ length: table.rows * table.cols }, (_, index) => <i className={table.withHeaderRow && index < table.cols ? 'header-cell' : ''} key={index} />)}</div><label className="dialog-checkbox"><input type="checkbox" checked={table.withHeaderRow} onChange={(event) => onChange({ ...table, withHeaderRow: event.target.checked })} /> Start with a header row</label><p>Click inside the table afterward to add or remove rows and columns, merge cells, or change its header row.</p></div><footer><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary">Insert table</button></footer></form></div>
}

function ContextMenuAction({ label, shortcut, disabled = false, onClick }: { label: string; shortcut: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="menuitem" disabled={disabled} onClick={onClick}><span>{label}</span><kbd>{shortcut}</kbd></button>
}

function EditorToolbar({ editor, spellcheck, aiEnabled, aiGrammarEnabled, grammarReviewing, researchReviewing, onSpellcheckChange, onAiGrammarEnabledChange, onGrammarReview, onResearchAndGrade, onAiThesaurus, onPaperContext, onVersionHistory, onExportPdf, onExportDocx, onImportPdf, onFind, onOpenLinkDialog, onOpenImageDialog, onOpenTableDialog }: { editor: NonNullable<ReturnType<typeof useEditor>>; spellcheck: boolean; aiEnabled: boolean; aiGrammarEnabled: boolean; grammarReviewing: boolean; researchReviewing: boolean; onSpellcheckChange: (value: boolean) => void; onAiGrammarEnabledChange: (value: boolean) => void; onGrammarReview: () => void; onResearchAndGrade: () => void; onAiThesaurus: () => void; onPaperContext: () => void; onVersionHistory: () => void; onExportPdf: () => void; onExportDocx: () => void; onImportPdf: () => void; onFind: () => void; onOpenLinkDialog: () => void; onOpenImageDialog: () => void; onOpenTableDialog: () => void }) {
  const pasteWithoutFormatting = async () => {
    try { const plain = await navigator.clipboard.readText(); editor.chain().focus().insertContent(plain).run() } catch { /* The platform's Ctrl+Shift+V fallback remains available. */ }
  }
  return <div className="editor-toolbar" role="toolbar" aria-label="Text formatting">
    <ToolbarMenu label="Document" icon={<Menu size={16} />} iconOnly><button onClick={onImportPdf}><Import size={15} />Import document</button><button onClick={onVersionHistory}><RefreshCw size={15} />Version history</button><hr /><button onClick={() => onSpellcheckChange(!spellcheck)}><SpellCheck2 size={15} />{spellcheck ? 'Disable spellcheck' : 'Enable spellcheck'}</button></ToolbarMenu>
    <ToolbarMenu label="Export" icon={<FileDown size={16} />} iconOnly><button onClick={onExportPdf}><FileDown size={15} />Export as PDF</button><button onClick={onExportDocx}><FileText size={15} />Export as Word (.docx)</button></ToolbarMenu>
    <Divider />
    <ToolbarMenu label="AI writing" icon={<Sparkles size={16} />} iconOnly disabled={!aiEnabled} popoverClassName="ai-writing-popover"><button onClick={() => onAiGrammarEnabledChange(!aiGrammarEnabled)}>{aiGrammarEnabled ? '✓ AI spelling & grammar' : 'AI spelling & grammar off'}</button><button onClick={onPaperContext}>AI Paper Context</button><button disabled={!aiGrammarEnabled || grammarReviewing} onClick={onGrammarReview}>{grammarReviewing ? 'Checking writing…' : 'AI Review'}</button><button disabled={researchReviewing} onClick={onResearchAndGrade}>{researchReviewing ? 'Researching your paper…' : 'AI Research & Grade'}</button><button onClick={onAiThesaurus}>AI Thesaurus</button></ToolbarMenu>
    <Divider />
    <ToolbarMenu label="Paragraph"><button onClick={() => editor.chain().focus().setParagraph().run()}><Pilcrow size={15} />Paragraph</button>{[1, 2, 3, 4, 5, 6].map((level) => <button key={level} onClick={() => editor.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run()}>Heading {level}</button>)}</ToolbarMenu>
    <Divider />
    <ToolButton label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={16} /></ToolButton>
    <ToolButton label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={16} /></ToolButton>
    <ToolButton label="Underline" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon size={16} /></ToolButton>
    <ToolButton label="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={16} /></ToolButton>
    <ToolbarMenu label="Text size"><button onClick={() => editor.chain().focus().setMark('textStyle', { fontSize: null }).run()}>Default (11 pt)</button>{[9, 10, 11, 12, 14, 16, 18].map((size) => <button onClick={() => editor.chain().focus().setMark('textStyle', { fontSize: `${size}pt` }).run()} key={size}>{size} pt</button>)}</ToolbarMenu>
    <ToolbarMenu label="Text color" icon={<Palette size={16} />}>{accentColors.map((color) => <button className="color-choice" onClick={() => editor.chain().focus().setColor(color).run()} key={color}><i style={{ background: color }} />{color === '#000000' ? 'Black' : color === '#E7E9F0' ? 'Soft white' : color}</button>)}<CustomHexColorControl label="Custom text color" initial="#000000" onApply={(color) => editor.chain().focus().setColor(color).run()} /><button onClick={() => editor.chain().focus().unsetColor().removeEmptyTextStyle().run()}>Reset color</button></ToolbarMenu>
    <ToolbarMenu label="Highlight" icon={<Highlighter size={16} />}>{highlights.map((color) => <button className="color-choice" onClick={() => editor.chain().focus().toggleHighlight({ color }).run()} key={color}><i style={{ background: color }} />{color}</button>)}<CustomHexColorControl label="Custom highlight" initial="#fff0a3" onApply={(color) => editor.chain().focus().setHighlight({ color }).run()} /><button onClick={() => editor.chain().focus().unsetHighlight().removeEmptyTextStyle().run()}>Clear highlight</button></ToolbarMenu>
    <Divider />
    <ToolButton label="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={17} /></ToolButton>
    <ToolButton label="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().updateAttributes('orderedList', { listStyle: 'decimal' }).run()}><ListOrdered size={17} /></ToolButton>
    <ToolButton label="Alphabetical list" active={editor.isActive('orderedList', { listStyle: 'upper-alpha' })} onClick={() => editor.chain().focus().toggleOrderedList().updateAttributes('orderedList', { listStyle: 'upper-alpha' }).run()}>A.</ToolButton>
    <ToolButton label="Checklist" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListTodo size={17} /></ToolButton>
    <ToolButton label="Indent selected lines (Tab)" onClick={() => { editor.commands.focus(); changeSelectedIndent(editor, 1) }}><IndentIncrease size={17} /></ToolButton>
    <ToolButton label="Outdent selected lines (Shift+Tab)" onClick={() => { editor.commands.focus(); changeSelectedIndent(editor, -1) }}><IndentDecrease size={17} /></ToolButton>
    <Divider />
    <ToolButton label="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}><AlignLeft size={16} /></ToolButton>
    <ToolButton label="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}><AlignCenter size={16} /></ToolButton>
    <ToolButton label="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}><AlignRight size={16} /></ToolButton>
    <Divider />
    <ToolButton label="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={16} /></ToolButton>
    <ToolButton label="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Code2 size={16} /></ToolButton>
    <ToolButton label="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code2 size={14} /></ToolButton>
    <ToolButton label="Superscript" active={editor.isActive('superscript')} onClick={() => editor.chain().focus().toggleSuperscript().run()}><SuperscriptIcon size={16} /></ToolButton>
    <ToolButton label="Subscript" active={editor.isActive('subscript')} onClick={() => editor.chain().focus().toggleSubscript().run()}><SubscriptIcon size={16} /></ToolButton>
    <Divider />
    <ToolButton label={editor.isActive('link') ? 'Edit or remove link' : 'Add link'} active={editor.isActive('link')} onClick={onOpenLinkDialog}><Link2 size={16} /></ToolButton>
    <ToolButton label="Add image" onClick={onOpenImageDialog}><ImagePlus size={16} /></ToolButton>
    <ToolbarMenu label="Table" icon={<Table2 size={16} />}><button onClick={onOpenTableDialog}>Insert table…</button>{editor.isActive('table') && <><hr /><button onClick={() => editor.chain().focus().addRowBefore().run()}>Insert row above</button><button onClick={() => editor.chain().focus().addRowAfter().run()}>Insert row below</button><button onClick={() => editor.chain().focus().deleteRow().run()}>Delete row</button><button onClick={() => editor.chain().focus().addColumnBefore().run()}>Insert column left</button><button onClick={() => editor.chain().focus().addColumnAfter().run()}>Insert column right</button><button onClick={() => editor.chain().focus().deleteColumn().run()}>Delete column</button><button onClick={() => editor.chain().focus().toggleHeaderRow().run()}>Toggle header row</button><button onClick={() => editor.chain().focus().mergeOrSplit().run()}>Merge or split cells</button><button className="toolbar-danger-action" onClick={() => editor.chain().focus().deleteTable().run()}>Delete table</button></>}</ToolbarMenu>
    <ToolButton label="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Columns3 size={16} /></ToolButton>
    <Divider />
    <ToolButton label="Undo" onClick={() => editor.chain().focus().undo().run()}><Undo2 size={16} /></ToolButton>
    <ToolButton label="Redo" onClick={() => editor.chain().focus().redo().run()}><Redo2 size={16} /></ToolButton>
    <ToolButton label="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting size={16} /></ToolButton>
    <ToolButton label="Paste without formatting" onClick={() => void pasteWithoutFormatting()}><ClipboardPaste size={16} /></ToolButton>
    <ToolButton label="Find" onClick={onFind}><Search size={16} /></ToolButton>
  </div>
}

function ToolButton({ label, active = false, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={active ? 'toolbar-button active' : 'toolbar-button'} title={label} aria-label={label} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}</button>
}

function ToolbarMenu({ label, icon, children, disabled = false, iconOnly = false, popoverClassName = '' }: { label: string; icon?: React.ReactNode; children: React.ReactNode; disabled?: boolean; iconOnly?: boolean; popoverClassName?: string }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const place = () => { const bounds = anchor.current?.getBoundingClientRect(); if (bounds) setPosition({ top: bounds.bottom + 8, left: Math.min(bounds.left, window.innerWidth - 170) }) }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => { const target = event.target as Node; if (!anchor.current?.contains(target) && !popover.current?.contains(target)) setOpen(false) }
    globalThis.document.addEventListener('mousedown', dismiss)
    return () => globalThis.document.removeEventListener('mousedown', dismiss)
  }, [open])
  return <div className="toolbar-menu"><button ref={anchor} className="toolbar-select" aria-label={label} title={label} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)}>{icon}{!iconOnly && <span>{label}</span>}{!iconOnly && <ChevronDown size={13} />}</button>{open && position && createPortal(<div ref={popover} className={`toolbar-popover toolbar-popover-floating ${popoverClassName}`} style={position} onMouseDown={(event) => { if (!(event.target as Element).closest('input')) event.preventDefault() }} onClick={(event) => { if (!(event.target as Element).closest('.toolbar-custom-color')) setOpen(false) }}>{children}</div>, globalThis.document.body)}</div>
}

function CustomHexColorControl({ label, initial, onApply }: { label: string; initial: string; onApply: (color: string) => void }) {
  const [value, setValue] = useState(initial)
  const valid = /^#[0-9a-fA-F]{6}$/.test(value.trim())
  const apply = (event: React.FormEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (valid) onApply(value.trim())
  }
  return <form className="toolbar-custom-color" onSubmit={apply} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><label>{label}<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="#000000" spellCheck={false} /></label><input type="color" value={valid ? value : initial} aria-label={`${label} picker`} onChange={(event) => setValue(event.target.value)} /><button type="submit" disabled={!valid}>Apply</button></form>
}

function Divider() { return <span className="toolbar-divider" /> }

function safeContent(content: string): object {
  try { return JSON.parse(content) as object } catch { return { type: 'doc', content: [{ type: 'paragraph' }] } }
}
