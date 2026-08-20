type TipTapNode = {
  type: string
  attrs?: Record<string, string | number>
  marks?: { type: string; attrs?: Record<string, string> }[]
  content?: TipTapNode[]
  text?: string
}

export interface ImportedPdfNote {
  title: string
  document: { type: 'doc'; content: TipTapNode[] }
  plainText: string
}

const clean = (value: string) => value.replace(/[\t\u00a0\u200b]+/g, ' ').replace(/\s+/g, ' ').trim()
const markdownInline = /(\[([^\]\n]+)\]\(([^)\s]+)\)|\(([^)\n]+)\)\[([^\]\s]+)\]|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`|https?:\/\/[^\s<>()]+)/g
const safeLink = (value: string) => /^(?:https?:\/\/|mailto:)/i.test(value) ? value : null
const textNode = (text: string): TipTapNode[] => {
  if (!text) return []
  const nodes: TipTapNode[] = []
  let cursor = 0
  for (const match of text.matchAll(markdownInline)) {
    const start = match.index ?? 0
    if (start > cursor) nodes.push({ type: 'text', text: text.slice(cursor, start) })
    const [source, _matched, markdownLabel, markdownUrl, reverseLabel, reverseUrl, doubleStar, doubleUnderscore, singleStar, singleUnderscore, code, bareUrl] = match
    const linkUrl = safeLink(markdownUrl || reverseUrl || bareUrl || '')
    if (linkUrl) nodes.push({ type: 'text', text: markdownLabel || reverseLabel || bareUrl || linkUrl, marks: [{ type: 'link', attrs: { href: linkUrl } }] })
    else if (doubleStar || doubleUnderscore || singleStar) nodes.push({ type: 'text', text: doubleStar || doubleUnderscore || singleStar, marks: [{ type: 'bold' }] })
    else if (singleUnderscore) nodes.push({ type: 'text', text: singleUnderscore, marks: [{ type: 'italic' }] })
    else if (code) nodes.push({ type: 'text', text: code, marks: [{ type: 'code' }] })
    else nodes.push({ type: 'text', text: source })
    cursor = start + source.length
  }
  if (cursor < text.length) nodes.push({ type: 'text', text: text.slice(cursor) })
  return nodes
}
const paragraph = (text: string, attrs?: Record<string, string | number>): TipTapNode => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: textNode(clean(text)) })
const listItem = (text: string): TipTapNode => ({ type: 'listItem', content: [paragraph(text)] })
const startsIndented = (line: string) => /^(?: {2,}|\t)/.test(line)
const explicitHeading = (line: string) => /^works cited$/i.test(line) || (/^[A-Z0-9][A-Z0-9 .,'\u2019-]{2,}$/.test(line) && line.length <= 80)
const bulletPattern = /^(?:[\u2022\u25cf\u25e6\u25aa\u2023*-]|\u2013)\s+(.+)$/
const orderedPattern = /^(\d+|[A-Za-z])[.)]\s+(.+)$/
const dateLine = (line: string) => /(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{2,4})/i.test(line)
const terminalLine = (line: string) => /[.!?\u201d\u2019)]$/.test(line.trim())
const citationStart = (line: string) => /^[\u201c"']/.test(line)
  || (!/\bhttps?:\/\//i.test(line) && (/^[A-Z][\p{L}\u2019'-]+,\s/u.test(line) || /^[A-Z][\p{L}\u2019'-]+\s+v\.\s/u.test(line)))

function meaningfulLines(text: string) {
  return text.replace(/\r/g, '').split('\n').map(clean).filter(Boolean)
}

/**
 * A text-native MLA PDF often loses its left indent during extraction, leaving a
 * blank line after every visual line. Recognising that shape lets us keep the
 * student's words intact instead of asking a language model to guess at them.
 */
export function isLikelyMlaPaperImport(text: string) {
  const lines = meaningfulLines(text)
  const dateIndex = lines.slice(0, 6).findIndex(dateLine)
  const title = dateIndex >= 0 ? lines[dateIndex + 1] : ''
  return dateIndex >= 2 && dateIndex <= 4 && Boolean(title) && title.length <= 160 && lines.length >= dateIndex + 4
}

function visualParagraphEnds(line: string, next: string | undefined, inWorksCited: boolean) {
  if (!next) return true
  if (inWorksCited && citationStart(next)) return true
  if (!terminalLine(line)) return false
  // A full-width line that happens to end a sentence normally continues the
  // same paragraph. A short final line is the reliable signal in plain PDF
  // extraction where original paragraph indentation was discarded.
  return line.length <= 56
}

function mlaPaperNodes(text: string): TipTapNode[] {
  const lines = meaningfulLines(text)
  const dateIndex = lines.slice(0, 6).findIndex(dateLine)
  if (dateIndex < 0) return []
  const titleIndex = dateIndex + 1
  const nodes = lines.slice(0, dateIndex + 1).map((line) => paragraph(line))
  nodes.push({ type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: textNode(lines[titleIndex]) })

  let current: string[] = []
  let inWorksCited = false
  const flush = () => {
    const value = clean(current.join(' '))
    if (value) nodes.push(paragraph(value, inWorksCited ? { hangingIndent: 1 } : { firstLineIndent: 1 }))
    current = []
  }

  for (let index = titleIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^works cited$/i.test(line)) {
      flush()
      inWorksCited = true
      nodes.push({ type: 'heading', attrs: { level: 2 }, content: textNode(line) })
      continue
    }
    if (inWorksCited && current.length && citationStart(line)) flush()
    current.push(line)
    if (visualParagraphEnds(line, lines[index + 1], inWorksCited)) flush()
  }
  flush()
  return nodes
}

function pageNodes(page: string): TipTapNode[] {
  const rawLines = page.replace(/\r/g, '').split('\n')
  const firstBodyLine = rawLines.findIndex((line) => startsIndented(line) && clean(line).length > 0)
  const nodes: TipTapNode[] = []
  let paragraphLines: string[] = []
  const flushParagraph = () => {
    const value = clean(paragraphLines.join(' '))
    if (value) nodes.push(paragraph(value))
    paragraphLines = []
  }

  // Google Docs preserves first-line paragraph indents in its PDF text stream. The
  // preceding lines are a heading block; its final line is the paper title.
  const bodyStart = firstBodyLine > 0 ? firstBodyLine : 0
  if (bodyStart > 0) {
    const headingBlock = rawLines.slice(0, bodyStart).map(clean).filter(Boolean)
    headingBlock.forEach((line, index) => {
      const isTitle = index === headingBlock.length - 1
      nodes.push(isTitle ? { type: 'heading', attrs: { level: 1 }, content: textNode(line) } : paragraph(line))
    })
  }

  for (let index = bodyStart; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index]
    const line = clean(rawLine)
    // pdf-extract emits a blank line after visual lines. Indentation, not that
    // transport spacing, tells us where a Google Docs paragraph begins.
    if (!line) continue

    const bulletMatch = line.match(bulletPattern)
    const orderedMatch = line.match(orderedPattern)
    if (bulletMatch || orderedMatch) {
      flushParagraph()
      const type = orderedMatch ? 'orderedList' : 'bulletList'
      const items: TipTapNode[] = []
      for (; index < rawLines.length; index += 1) {
        const candidate = clean(rawLines[index])
        if (!candidate) continue
        const match = orderedMatch ? candidate.match(orderedPattern) : candidate.match(bulletPattern)
        if (!match) { index -= 1; break }
        items.push(listItem(match[match.length - 1]))
      }
      nodes.push({ type, content: items })
      continue
    }

    const markdownHeading = line.match(/^(#{1,6})\s+(.+)$/)
    if (markdownHeading) {
      flushParagraph()
      nodes.push({ type: 'heading', attrs: { level: markdownHeading[1].length }, content: textNode(markdownHeading[2]) })
      continue
    }

    if (explicitHeading(line)) {
      flushParagraph()
      nodes.push({ type: 'heading', attrs: { level: 2 }, content: textNode(line) })
      continue
    }

    if (startsIndented(rawLine) && paragraphLines.length) flushParagraph()
    paragraphLines.push(line)
  }
  flushParagraph()
  return nodes
}

function sourceName(path: string) {
  const file = path.split(/[\\/]/).pop() ?? 'Imported PDF'
  return clean(file.replace(/\.(pdf|doc|docx)$/i, '')) || 'Imported document'
}

export function importPdfAsEditableNote(text: string, path: string): ImportedPdfNote {
  if (isLikelyMlaPaperImport(text)) {
    const content = mlaPaperNodes(text)
    const title = content.find((node) => node.type === 'heading' && node.attrs?.level === 1)?.content?.[0]?.text
    return {
      title: title || sourceName(path),
      document: { type: 'doc', content: content.length ? content : [paragraph('')] },
      plainText: text.replace(/\s+\n/g, '\n').trim(),
    }
  }
  const pages = text.split('\f').map((page) => page.trim()).filter(Boolean)
  const content = pages.flatMap((page, index) => {
    const nodes = pageNodes(page)
    return index === 0 ? nodes : [{ type: 'horizontalRule' } as TipTapNode, ...nodes]
  })
  const firstHeading = content.find((node) => node.type === 'heading')?.content?.[0]?.text
  return {
    title: firstHeading || sourceName(path),
    document: { type: 'doc', content: content.length ? content : [paragraph('')] },
    plainText: pages.join('\n\n').replace(/\s+\n/g, '\n').trim(),
  }
}

function nodeText(node: TipTapNode) {
  return node.content?.map((child) => child.text ?? '').join('') ?? ''
}

function hasMlaHeadingBlock(sourceText: string) {
  const lines = meaningfulLines(sourceText)
  const dateIndex = lines.slice(0, 6).findIndex(dateLine)
  return dateIndex >= 2 && dateIndex <= 4 && Boolean(lines[dateIndex + 1]) && lines[dateIndex + 1].length <= 160 && lines.length >= dateIndex + 3
}

function preserveMlaHeading(content: TipTapNode[], sourceText?: string, path?: string) {
  // Only an actual MLA-style paper has a four-line heading to preserve. Course
  // documents often contain indented lists; treating that indentation as an
  // MLA heading block prepends the opening material a second time.
  if (!sourceText || !path || !hasMlaHeadingBlock(sourceText)) return content
  const source = importPdfAsEditableNote(sourceText, path).document.content
  const sourceTitle = source.findIndex((node) => node.type === 'heading' && node.attrs?.level === 1)
  if (sourceTitle <= 0) return content
  const headingBlock = source.slice(0, sourceTitle)
  const matchingHeaderAt = content.findIndex((_, start) => headingBlock.every((node, index) => clean(nodeText(content[start + index] ?? { type: 'paragraph' })) === clean(nodeText(node))))
  const withoutCopiedHeader = matchingHeaderAt < 0 ? content : [...content.slice(0, matchingHeaderAt), ...content.slice(matchingHeaderAt + headingBlock.length)]
  return [...headingBlock, ...withoutCopiedHeader]
}

export function importAiFormattedNote(markdown: string, path: string, sourceText?: string): ImportedPdfNote {
  const cleanedMarkdown = markdown.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\r/g, '').replace(/^\s*```(?:markdown|md)?\s*$/gim, '').replace(/^\s*```\s*$/gm, '').trim()
  const hasFormatting = /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/m.test(cleanedMarkdown)
  // The model occasionally echoes an extracted PDF line-for-line. That is a
  // valid-looking answer but not formatted Markdown, and turning it into one
  // paragraph per visual line is exactly the broken import users were seeing.
  // For a recognisable MLA paper, the deterministic parser is both safer and
  // more faithful because it never changes a word of the original source.
  if (sourceText && isLikelyMlaPaperImport(sourceText) && !hasFormatting) {
    return importPdfAsEditableNote(sourceText, path)
  }
  const lines = cleanedMarkdown.split('\n')
  const content: TipTapNode[] = []
  const isTableRow = (line: string) => /^\s*\|.+\|\s*$/.test(line)
  const isTableSeparator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
  const cell = (value: string, type: 'tableHeader' | 'tableCell'): TipTapNode => ({ type, content: [paragraph(value)] })
  const rowValues = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(clean)
  const paragraphFromMarkdownLines = (parts: { text: string; breakAfter: boolean }[]) => ({
    type: 'paragraph',
    content: parts.flatMap((part, index) => [
      ...(index ? (parts[index - 1].breakAfter ? [{ type: 'hardBreak' } as TipTapNode] : textNode(' ')) : []),
      ...textNode(part.text),
    ]),
  } as TipTapNode)

  for (let index = 0; index < lines.length;) {
    const rawLine = lines[index]
    const line = rawLine.trim()
    if (!line) { index += 1; continue }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    const bullet = line.match(/^[-*+]\s+(.+)$/)
    const ordered = line.match(/^\d+[.)]\s+(.+)$/)
    const quote = line.match(/^>\s+(.+)$/)
    if (heading) { content.push({ type: 'heading', attrs: { level: Math.min(6, heading[1].length) }, content: textNode(heading[2]) }); index += 1; continue }
    if (quote) { content.push({ type: 'blockquote', content: [paragraph(quote[1])] }); index += 1; continue }
    if (isTableRow(rawLine) && isTableSeparator(lines[index + 1] ?? '')) {
      const headers = rowValues(rawLine)
      const rows: string[][] = []
      index += 2
      while (isTableRow(lines[index] ?? '')) { rows.push(rowValues(lines[index])); index += 1 }
      content.push({ type: 'table', content: [{ type: 'tableRow', content: headers.map((value) => cell(value, 'tableHeader')) }, ...rows.map((row) => ({ type: 'tableRow', content: row.map((value) => cell(value, 'tableCell')) }))] })
      continue
    }
    if (bullet || ordered) {
      const type = bullet ? 'bulletList' : 'orderedList'
      const matcher = bullet ? /^[-*+]\s+(.+)$/ : /^\d+[.)]\s+(.+)$/
      const items: TipTapNode[] = []
      let itemLines: string[] = []
      const flushItem = () => { if (itemLines.length) items.push(listItem(itemLines.join(' '))); itemLines = [] }
      while (index < lines.length) {
        const candidate = lines[index].trim()
        const match = candidate.match(matcher)
        if (match) { flushItem(); itemLines.push(match[1]); index += 1; continue }
        if (!candidate) { index += 1; break }
        if (candidate.match(/^(#{1,6})\s+/) || candidate.match(/^>\s+(.+)$/) || candidate.match(/^[-*+]\s+(.+)$/) || candidate.match(/^\d+[.)]\s+(.+)$/) || isTableRow(lines[index])) break
        itemLines.push(candidate); index += 1
      }
      flushItem()
      if (items.length) content.push({ type, content: items })
      continue
    }
    const parts: { text: string; breakAfter: boolean }[] = []
    while (index < lines.length) {
      const candidateRaw = lines[index]
      const candidate = candidateRaw.trim()
      if (!candidate) break
      if (parts.length && (candidate.match(/^(#{1,6})\s+/) || candidate.match(/^>\s+(.+)$/) || candidate.match(/^[-*+]\s+(.+)$/) || candidate.match(/^\d+[.)]\s+(.+)$/) || isTableRow(candidateRaw))) break
      const breakAfter = /\s{2}$|<br\s*\/?>\s*$/i.test(candidateRaw)
      parts.push({ text: candidate.replace(/<br\s*\/?>\s*$/i, ''), breakAfter })
      index += 1
    }
    if (parts.length) content.push(paragraphFromMarkdownLines(parts))
    else index += 1
  }
  const preservedContent = preserveMlaHeading(content, sourceText, path)
  const firstHeading = preservedContent.find((node) => node.type === 'heading')?.content?.[0]?.text
  return { title: firstHeading || sourceName(path), document: { type: 'doc', content: preservedContent.length ? preservedContent : [paragraph('')] }, plainText: cleanedMarkdown.replace(/^#{1,6}\s+/gm, '').replace(/^[-*+]\s+/gm, '').trim() }
}
