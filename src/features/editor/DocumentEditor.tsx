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
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { AlignCenter, AlignLeft, AlignRight, Bold, ChevronDown, ClipboardPaste, Code2, Columns3, FileDown, FileText, Highlighter, ImagePlus, Import, IndentDecrease, IndentIncrease, Italic, Link2, List, ListOrdered, ListTodo, Palette, Pilcrow, Quote, Redo2, RemoveFormatting, Search, Settings2, Strikethrough, Subscript as SubscriptIcon, Superscript as SuperscriptIcon, Table2, Underline as UnderlineIcon, Undo2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocumentDetail } from '../../lib/types'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { api } from '../../lib/api'
import { importPdfAsEditableNote } from './pdfImport'

interface DocumentEditorProps {
  document: DocumentDetail
  spellcheck: boolean
  fontSize: number
  readingSurface: 'paper' | 'midnight' | 'slate' | 'sepia'
  saveState: 'saved' | 'saving' | 'error'
  onChange: (content: string, contentPlain: string, title: string) => void
  onBack: () => void
  onDelete: () => void
  onDuplicate?: () => void
  collectionLabel?: string
  deleteLabel?: string
  deriveTitle?: boolean
  context?: string
}

const accentColors = ['#E7E9F0', '#F08B8B', '#F1BD6A', '#86C59A', '#7EB7ED', '#B79CF4']
const highlights = ['#FFF0A3', '#F5B7D4', '#BFE9DA', '#C7DDF9', '#E6D4FF']
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
const PaperIndent = Extension.create({
  name: 'paperIndent',
  addGlobalAttributes() {
    return [{ types: ['paragraph', 'heading'], attributes: {
      indent: { default: 0, parseHTML: (element: HTMLElement) => Number.parseInt(element.dataset.indent ?? '0', 10) || 0, renderHTML: (attributes: { indent?: number }) => attributes.indent ? { 'data-indent': attributes.indent, style: `margin-left: ${attributes.indent * .5}in` } : {} },
      firstLineIndent: { default: 0, parseHTML: (element: HTMLElement) => Number.parseInt(element.dataset.firstLineIndent ?? '0', 10) || 0, renderHTML: (attributes: { firstLineIndent?: number }) => attributes.firstLineIndent ? { 'data-first-line-indent': attributes.firstLineIndent } : {} },
      hangingIndent: { default: 0, parseHTML: (element: HTMLElement) => Number.parseInt(element.dataset.hangingIndent ?? '0', 10) || 0, renderHTML: (attributes: { hangingIndent?: number }) => attributes.hangingIndent ? { 'data-hanging-indent': attributes.hangingIndent } : {} },
    } }]
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => changeSelectedIndent(this.editor, 1),
      'Shift-Tab': () => changeSelectedIndent(this.editor, -1),
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
    } }]
  },
})
const paperPaginationKey = new PluginKey<DecorationSet>('paperPagination')
const paperGap = 34
const usLetterWidthInches = 8.5
const usLetterHeightInches = 11

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
  const pageHeight = paper.clientWidth * usLetterHeightInches / usLetterWidthInches
  const topInset = Number.parseFloat(paperStyle.paddingTop) || 0
  const bottomInset = Number.parseFloat(paperStyle.paddingBottom) || 0
  const title = paper.querySelector<HTMLElement>('.document-title')
  const titleStyle = title ? window.getComputedStyle(title) : null
  const titleHeight = title ? title.getBoundingClientRect().height + (Number.parseFloat(titleStyle?.marginBottom ?? '0') || 0) : 0
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
  view.state.doc.forEach((_node, offset) => {
    const nodeDom = view.nodeDOM(offset)
    if (!(nodeDom instanceof HTMLElement)) return
    const style = window.getComputedStyle(nodeDom)
    const blockHeight = nodeDom.getBoundingClientRect().height + (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0)
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

export function DocumentEditor({ document, spellcheck, fontSize, readingSurface, saveState, onChange, onBack, onDelete, onDuplicate, collectionLabel = 'Papers', deleteLabel = 'Move to trash', deriveTitle = true, context }: DocumentEditorProps) {
  const [findOpen, setFindOpen] = useState(false)
  const [findValue, setFindValue] = useState('')
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false)
  const [pageMargin, setPageMargin] = useState<'normal' | 'narrow' | 'wide'>('normal')
  const [lineSpacing, setLineSpacing] = useState<'single' | 'docs' | 'one-half' | 'double'>('docs')
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
  const [linkDialog, setLinkDialog] = useState<{ url: string; canRemove: boolean } | null>(null)
  const [linkPreview, setLinkPreview] = useState<{ href: string; label: string; x: number; y: number } | null>(null)
  const [imageDialog, setImageDialog] = useState<{ src: string } | null>(null)
  const [tableDialog, setTableDialog] = useState<{ rows: number; cols: number; withHeaderRow: boolean } | null>(null)
  const linkPreviewRef = useRef<{ href: string; label: string; x: number; y: number } | null>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const activeRunningElementRef = useRef<HTMLElement | null>(null)
  const setActiveLinkPreview = (preview: { href: string; label: string; x: number; y: number } | null) => { linkPreviewRef.current = preview; setLinkPreview(preview) }
  const openExternalLink = (href: string) => { void openUrl(href).catch(() => { globalThis.open(href, '_blank', 'noopener,noreferrer') }) }
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
  const content = useMemo(() => safeContent(document.content), [document.content])
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: { HTMLAttributes: { class: 'code-block' } } }),
      Underline, TextStyle, FontSize, OrderedListStyle, PaperIndent, PaperMeta, PaperPagination, Color, Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }), TaskList, TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
      Image.configure({ inline: false, allowBase64: true }), Table.configure({ resizable: true, allowTableNodeSelection: true }), TableRow, TableHeader, TableCell,
      Superscript, Subscript, Placeholder.configure({ placeholder: 'Start writing…' }), Typography,
    ],
    content,
    editorProps: {
      attributes: { class: 'soflo-editor', spellcheck: String(spellcheck), style: `font-size: ${fontSize}pt` },
      handleClick: handleLinkClick,
    },
    onUpdate: ({ editor: nextEditor }) => onChange(JSON.stringify(nextEditor.getJSON()), nextEditor.getText(), deriveTitle ? derivePaperTitle(nextEditor) : document.title),
  })
  const currentId = useRef(document.id)
  useEffect(() => {
    if (!editor || currentId.current === document.id) return
    currentId.current = document.id
    editor.commands.setContent(safeContent(document.content), { emitUpdate: false })
  }, [document.id, document.content, editor])
  useEffect(() => { editor?.setOptions({ editorProps: { attributes: { class: 'soflo-editor', spellcheck: String(spellcheck), style: `font-size: ${fontSize}pt` }, handleClick: handleLinkClick } }) }, [editor, spellcheck, fontSize])
  useEffect(() => { if (editor) editor.view.dispatch(editor.state.tr.setMeta(paperPaginationKey, measurePaperBreaks(editor.view))) }, [editor, fontSize, lineSpacing, pageMargin, headerPages, footerPages, repeatHeader, repeatFooter])
  useEffect(() => {
    if (!editor) return
    const attributes = editor.getAttributes('doc') as { headerText?: string; footerText?: string; headerPages?: unknown; footerPages?: unknown; repeatHeader?: boolean; repeatFooter?: boolean; showPageNumbers?: boolean }
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
    const dismiss = () => setContextMenu(null)
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    window.addEventListener('click', dismiss)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('click', dismiss); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); window.removeEventListener('keydown', onKeyDown) }
  }, [contextMenu])

  if (!editor) return <div className="editor-loading" />
  const runFind = (value: string) => { setFindValue(value); const finder = (window as Window & { find?: (query: string, caseSensitive?: boolean, backwards?: boolean, wrapAround?: boolean) => boolean }).find; if (value && finder) finder(value, false, false, true) }
  const exportPdf = () => {
    setPdfMessage('Opening your PDF export dialog…')
    try { globalThis.print() } catch { setPdfMessage('SoFlo could not open the PDF export dialog.') }
  }
  const importPdf = async () => {
    const source = await open({ title: 'Import PDF text into this paper', multiple: false, directory: false, filters: [{ name: 'PDF document', extensions: ['pdf'] }] })
    if (!source || Array.isArray(source)) return
    setPdfMessage('Importing editable text…')
    try {
      const extracted = await api.importPdfText(source)
      const imported = importPdfAsEditableNote(extracted, source)
      editor.chain().focus().setTextSelection(editor.state.doc.content.size).insertContent(imported.document.content).run()
      setPdfMessage('Structured PDF content added to the end of this paper.')
    } catch (error) { setPdfMessage(error instanceof Error ? error.message : 'SoFlo could not import that PDF.') }
  }
  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 222), y: Math.min(event.clientY, window.innerHeight - 270) })
  }
  const runContextAction = async (action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => {
    setContextMenu(null)
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
    const target = event.target as HTMLElement
    if (target.closest('.soflo-editor, .document-title, button, input, textarea, a, .paper-running-header, .paper-running-footer')) return
    event.preventDefault()
    editor.chain().focus('end').run()
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
    return <div ref={Ref} className={`paper-running-${region}${active ? ' editing' : ''}${value || active ? '' : ' empty'}`} contentEditable={active} suppressContentEditableWarning onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); beginRunningEdit(region, 1, event.currentTarget, event.clientX, event.clientY) }} onBlur={(event) => saveRunningRegion(region, 1, serializeRunningRegion(event.currentTarget))} />
  }
  return <main className="editor-view">
    <header className="editor-topbar">
      <div className="editor-breadcrumb"><button className="editor-breadcrumb-link" onClick={onBack}><FileText size={15} />{collectionLabel}</button><span className="breadcrumb-separator">/</span><span>{document.title || 'Untitled paper'}</span>{context && <small className="editor-context">{context}</small>}</div>
      <div className={`save-indicator ${saveState}`}><span />{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Couldn’t save' : 'Saved'}</div>
      <div className="editor-actions">{onDuplicate && <button className="editor-action" onClick={onDuplicate}>Duplicate</button>}<button className="editor-action danger" onClick={onDelete}>{deleteLabel}</button></div>
    </header>
    <div className="editor-toolbar-wrap">
      <EditorToolbar editor={editor} onFind={() => window.dispatchEvent(new Event('soflo:open-find'))} onOpenLinkDialog={openLinkDialog} onOpenImageDialog={() => setImageDialog({ src: '' })} onOpenTableDialog={() => setTableDialog({ rows: 3, cols: 3, withHeaderRow: true })} />
    </div>
    {editingRegion && <div className="header-footer-context-menu" role="menu" aria-label={`${editingRegion.region === 'header' ? 'Header' : 'Footer'} tools`} style={{ left: Math.min(editingRegion.x, window.innerWidth - 228), top: Math.min(editingRegion.y + 10, window.innerHeight - 174) }} onMouseDown={(event) => event.preventDefault()}><span>{editingRegion.region === 'header' ? `Header · page ${editingRegion.page}` : `Footer · page ${editingRegion.page}`}</span><button type="button" onClick={() => insertRunningField('page-number')}>Insert page number</button><button type="button" onClick={() => insertRunningField('page-x-of-y')}>Insert Page X of Y</button><button type="button" className={(editingRegion.region === 'header' ? repeatHeader : repeatFooter) ? 'active' : ''} onClick={toggleRunningRepeat}>{(editingRegion.region === 'header' ? repeatHeader : repeatFooter) ? 'Edit each page separately' : 'Make same on every page'}</button></div>}
    {findOpen && <div className="find-bar"><Search size={15} /><input id="find-input" value={findValue} onChange={(event) => runFind(event.target.value)} placeholder="Find in document" /><span>{findValue ? 'Use Enter to find next' : ''}</span><button className="icon-button tiny" onClick={() => setFindOpen(false)} aria-label="Close find">×</button></div>}
    <section className="editor-page-wrap" onMouseDown={focusBlankPaper}><article className={`document-page reading-${readingSurface} page-margin-${pageMargin} page-line-${lineSpacing} has-running-header has-running-footer`} data-running-header={headerText} data-running-footer={footerText} data-running-header-pages={JSON.stringify(headerPages)} data-running-footer-pages={JSON.stringify(footerPages)} data-repeat-header={repeatHeader} data-repeat-footer={repeatFooter} data-show-page-numbers={showPageNumbers} onMouseDown={focusBlankPaper}>{runningRegion('header')}<EditorContent editor={editor} onContextMenu={openContextMenu} />{runningRegion('footer')}</article></section>
    {linkPreview && <aside className="editor-link-preview" style={{ left: linkPreview.x, top: linkPreview.y }} aria-label="Link destination"><div><small>LINK DESTINATION</small><strong title={linkPreview.href}>{linkPreview.label}</strong><span title={linkPreview.href}>{linkPreview.href}</span></div><button className="button button-primary button-small" onClick={() => { openExternalLink(linkPreview.href); setActiveLinkPreview(null) }}>Open</button><button className="icon-button tiny" onClick={() => setActiveLinkPreview(null)} aria-label="Close link preview"><X size={15} /></button></aside>}
    {contextMenu && <div className="editor-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" aria-label="Paper editing menu"><ContextMenuAction label="Undo" shortcut="Ctrl Z" disabled={!editor.can().undo()} onClick={() => void runContextAction('undo')} /><ContextMenuAction label="Redo" shortcut="Ctrl Shift Z" disabled={!editor.can().redo()} onClick={() => void runContextAction('redo')} /><hr /><ContextMenuAction label="Cut" shortcut="Ctrl X" disabled={editor.state.selection.empty} onClick={() => void runContextAction('cut')} /><ContextMenuAction label="Copy" shortcut="Ctrl C" disabled={editor.state.selection.empty} onClick={() => void runContextAction('copy')} /><ContextMenuAction label="Paste" shortcut="Ctrl V" onClick={() => void runContextAction('paste')} /><hr /><ContextMenuAction label="Select all" shortcut="Ctrl A" onClick={() => void runContextAction('selectAll')} /></div>}
    {linkDialog && <LinkDialog initialUrl={linkDialog.url} canRemove={linkDialog.canRemove} onClose={() => setLinkDialog(null)} onApply={applyLink} onRemove={() => { editor.chain().focus().unsetLink().run(); setLinkDialog(null) }} />}
    {imageDialog && <ImageDialog source={imageDialog.src} onClose={() => setImageDialog(null)} onSourceChange={(src) => setImageDialog({ src })} onInsert={insertImage} />}
    {tableDialog && <TableDialog table={tableDialog} onClose={() => setTableDialog(null)} onChange={setTableDialog} onInsert={insertTable} />}
    <button className="page-settings-button" aria-label="Page settings" title="Page settings" onClick={() => setPageSettingsOpen((open) => !open)}><Settings2 size={20} /></button>
    {pageSettingsOpen && <aside className="page-settings-panel" aria-label="Page settings"><header><div><p className="eyebrow">DOCUMENT</p><h2>Page settings</h2></div><button className="icon-button" onClick={() => setPageSettingsOpen(false)} aria-label="Close page settings"><X size={18} /></button></header><div className="page-settings-content"><div className="paper-spec"><span>US</span><div><strong>US Letter</strong><small>8.5 × 11 in · Google Docs baseline</small></div></div><fieldset><legend>Margins</legend><div className="segmented-control">{(['narrow', 'normal', 'wide'] as const).map((option) => <button key={option} className={pageMargin === option ? 'active' : ''} onClick={() => setPageMargin(option)}>{option}</button>)}</div></fieldset><fieldset><legend>Line spacing</legend><div className="segmented-control segmented-control-four">{([['single', '1.0'], ['docs', '1.15'], ['one-half', '1.5'], ['double', '2.0']] as const).map(([option, label]) => <button key={option} className={lineSpacing === option ? 'active' : ''} onClick={() => setLineSpacing(option)}>{label}</button>)}</div></fieldset><p className="page-settings-note">Normal margins, 11 pt Arial, black text, and 1.15 line spacing are the default.</p><div className="page-settings-actions"><button className="button button-primary button-small" onClick={() => void exportPdf()}><FileDown size={15} /> Export PDF</button><button className="button button-quiet button-small" onClick={() => void importPdf()}><Import size={15} /> Import PDF text</button></div>{pdfMessage && <p className="page-settings-message">{pdfMessage}</p>}<p className="page-settings-note">Export opens the native Print dialog. Choose <strong>Microsoft Print to PDF</strong> to save a properly sized Letter PDF.</p></div></aside>}
  </main>
}

function LinkDialog({ initialUrl, canRemove, onClose, onApply, onRemove }: { initialUrl: string; canRemove: boolean; onClose: () => void; onApply: (url: string) => void; onRemove: () => void }) {
  const [url, setUrl] = useState(initialUrl)
  return <div className="editor-dialog-backdrop" role="presentation"><form className="editor-dialog" aria-label="Add or edit link" onSubmit={(event) => { event.preventDefault(); onApply(url) }}><header><div><p className="eyebrow">LINK</p><h2>{canRemove ? 'Edit link' : 'Add link'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close link dialog"><X size={18} /></button></header><div className="editor-dialog-content"><label>Web address<input type="url" autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" inputMode="url" /></label><p>Highlight text first, then apply a link to it.</p></div><footer>{canRemove && <button type="button" className="button button-danger button-small" onClick={onRemove}>Remove link</button>}<span /><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!url.trim()}>Apply link</button></footer></form></div>
}

function ImageDialog({ source, onClose, onSourceChange, onInsert }: { source: string; onClose: () => void; onSourceChange: (source: string) => void; onInsert: (source: string) => void }) {
  const chooseFile = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') onSourceChange(reader.result) }
    reader.readAsDataURL(file)
  }
  return <div className="editor-dialog-backdrop" role="presentation"><form className="editor-dialog" aria-label="Add image" onSubmit={(event) => { event.preventDefault(); onInsert(source) }}><header><div><p className="eyebrow">IMAGE</p><h2>Add an image</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close image dialog"><X size={18} /></button></header><div className="editor-dialog-content"><label>Image URL<input type="url" autoFocus value={source.startsWith('data:') ? '' : source} onChange={(event) => onSourceChange(event.target.value)} placeholder="https://example.com/image.png" inputMode="url" /></label><div className="image-file-picker"><span>or</span><label className="button button-quiet button-small"><ImagePlus size={15} /> Choose image file<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange={(event) => chooseFile(event.currentTarget.files?.[0])} /></label></div>{source && <div className="image-preview"><img src={source} alt="Selected image preview" /></div>}<p>Image files are saved inside this paper so they remain available on this PC.</p></div><footer><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!source.trim()}>Insert image</button></footer></form></div>
}

function TableDialog({ table, onClose, onChange, onInsert }: { table: { rows: number; cols: number; withHeaderRow: boolean }; onClose: () => void; onChange: (table: { rows: number; cols: number; withHeaderRow: boolean }) => void; onInsert: (table: { rows: number; cols: number; withHeaderRow: boolean }) => void }) {
  const setDimension = (key: 'rows' | 'cols', value: number) => onChange({ ...table, [key]: Math.max(1, Math.min(20, Number.isFinite(value) ? value : 1)) })
  return <div className="editor-dialog-backdrop" role="presentation"><form className="editor-dialog table-dialog" aria-label="Insert table" onSubmit={(event) => { event.preventDefault(); onInsert(table) }}><header><div><p className="eyebrow">TABLE</p><h2>Insert table</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close table dialog"><X size={18} /></button></header><div className="editor-dialog-content"><div className="table-size-fields"><label>Columns<input type="number" min="1" max="20" value={table.cols} onChange={(event) => setDimension('cols', Number(event.target.value))} /></label><span>×</span><label>Rows<input type="number" min="1" max="20" value={table.rows} onChange={(event) => setDimension('rows', Number(event.target.value))} /></label></div><div className="table-preview" style={{ gridTemplateColumns: `repeat(${table.cols}, 1fr)` }} aria-label={`${table.rows} by ${table.cols} table preview`}>{Array.from({ length: table.rows * table.cols }, (_, index) => <i className={table.withHeaderRow && index < table.cols ? 'header-cell' : ''} key={index} />)}</div><label className="dialog-checkbox"><input type="checkbox" checked={table.withHeaderRow} onChange={(event) => onChange({ ...table, withHeaderRow: event.target.checked })} /> Start with a header row</label><p>Click inside the table afterward to add or remove rows and columns, merge cells, or change its header row.</p></div><footer><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary">Insert table</button></footer></form></div>
}

function ContextMenuAction({ label, shortcut, disabled = false, onClick }: { label: string; shortcut: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="menuitem" disabled={disabled} onClick={onClick}><span>{label}</span><kbd>{shortcut}</kbd></button>
}

function EditorToolbar({ editor, onFind, onOpenLinkDialog, onOpenImageDialog, onOpenTableDialog }: { editor: NonNullable<ReturnType<typeof useEditor>>; onFind: () => void; onOpenLinkDialog: () => void; onOpenImageDialog: () => void; onOpenTableDialog: () => void }) {
  const pasteWithoutFormatting = async () => {
    try { const plain = await navigator.clipboard.readText(); editor.chain().focus().insertContent(plain).run() } catch { /* The platform's Ctrl+Shift+V fallback remains available. */ }
  }
  return <div className="editor-toolbar" role="toolbar" aria-label="Text formatting">
    <ToolbarMenu label="Paragraph"><button onClick={() => editor.chain().focus().setParagraph().run()}><Pilcrow size={15} />Paragraph</button><button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>Heading 1</button><button onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>Heading 2</button><button onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>Heading 3</button></ToolbarMenu>
    <Divider />
    <ToolButton label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={16} /></ToolButton>
    <ToolButton label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={16} /></ToolButton>
    <ToolButton label="Underline" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon size={16} /></ToolButton>
    <ToolButton label="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={16} /></ToolButton>
    <ToolbarMenu label="Text size"><button onClick={() => editor.chain().focus().setMark('textStyle', { fontSize: null }).run()}>Default (11 pt)</button>{[9, 10, 11, 12, 14, 16, 18].map((size) => <button onClick={() => editor.chain().focus().setMark('textStyle', { fontSize: `${size}pt` }).run()} key={size}>{size} pt</button>)}</ToolbarMenu>
    <ToolbarMenu label="Text color" icon={<Palette size={16} />}>{accentColors.map((color) => <button className="color-choice" onClick={() => editor.chain().focus().setColor(color).run()} key={color}><i style={{ background: color }} />{color === '#E7E9F0' ? 'Default' : color}</button>)}<button onClick={() => editor.chain().focus().unsetColor().run()}>Reset color</button></ToolbarMenu>
    <ToolbarMenu label="Highlight" icon={<Highlighter size={16} />}>{highlights.map((color) => <button className="color-choice" onClick={() => editor.chain().focus().toggleHighlight({ color }).run()} key={color}><i style={{ background: color }} />{color}</button>)}<button onClick={() => editor.chain().focus().unsetHighlight().run()}>Clear highlight</button></ToolbarMenu>
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

function ToolbarMenu({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
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
  return <div className="toolbar-menu"><button ref={anchor} className="toolbar-select" aria-label={label} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)}>{icon}<span>{label}</span><ChevronDown size={13} /></button>{open && position && createPortal(<div ref={popover} className="toolbar-popover toolbar-popover-floating" style={position} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen(false)}>{children}</div>, globalThis.document.body)}</div>
}

function Divider() { return <span className="toolbar-divider" /> }

function safeContent(content: string): object {
  try { return JSON.parse(content) as object } catch { return { type: 'doc', content: [{ type: 'paragraph' }] } }
}
