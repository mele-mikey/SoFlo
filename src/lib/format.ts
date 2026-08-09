export function formatDate(value: string): string {
  const date = new Date(`${value.endsWith('Z') ? value : `${value}Z`}`)
  const elapsed = Date.now() - date.getTime()
  const minute = 60_000
  if (elapsed < minute) return 'Just now'
  if (elapsed < minute * 60) return `${Math.round(elapsed / minute)}m ago`
  if (elapsed < minute * 60 * 24) return `${Math.round(elapsed / (minute * 60))}h ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

export function classLabel(course: { courseCode: string; name: string }): string {
  return course.courseCode.trim() || course.name
}

export function normalizeAnswer(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?()[\]{}"']/g, '')
}
