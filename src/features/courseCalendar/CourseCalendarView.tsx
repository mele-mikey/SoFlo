import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  Archive,
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  FileUp,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../lib/api";
import type {
  CourseCalendarDetail,
  CourseCalendarItem,
  CourseCalendarSource,
  CourseClass,
} from "../../lib/types";
import "./CourseCalendar.css";

type Toast = (message: string, kind?: "success" | "error") => void;
type PlanStep = { action: string; context?: string };
type AiProgress = { progress: number; message: string };
type ManualDraft = {
  title: string;
  dueDate: string;
  startTime: string;
  description: string;
  color: string;
};
const eventColors = [
  "#8B7CF6",
  "#63B98F",
  "#7E8ADE",
  "#E8B558",
  "#EF8794",
  "#4E86D9",
];
const emptyCalendar = (classId: string): CourseCalendarDetail => ({
  classId,
  sources: [],
  items: [],
  gamePlan: "",
  updatedAt: null,
});
const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const startOfWeek = (value: Date) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date;
};
const weekLabel = (start: Date) => {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
};
const newManualDraft = (): ManualDraft => ({
  title: "",
  dueDate: isoDate(new Date()),
  startTime: "",
  description: "",
  color: eventColors[0],
});
function inline(value: string | PlanStep): ReactNode {
  if (typeof value !== "string")
    return (
      <span className="course-plan-step">
        <strong>{inline(value.action)}</strong>
        {value.context && <small>{inline(value.context)}</small>}
      </span>
    );
  return value
    .split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      const link = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
      if (link)
        return (
          <a key={index} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
      return part.startsWith("**") && part.endsWith("**") ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : (
        <span key={index}>{part}</span>
      );
    });
}
function MarkdownBlocks({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const value = paragraph.join(" ").trim();
    if (value) blocks.push(<p key={`p-${blocks.length}`}>{inline(value)}</p>);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; ) {
    const line = lines[index].trim();
    if (!line) {
      flush();
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (heading) {
      flush();
      const Tag = `h${heading[1].length}` as
        | "h1"
        | "h2"
        | "h3"
        | "h4"
        | "h5"
        | "h6";
      blocks.push(<Tag key={`h-${blocks.length}`}>{inline(heading[2])}</Tag>);
      index += 1;
      continue;
    }
    if (bullet || ordered) {
      flush();
      const Tag = ordered ? "ol" : "ul";
      const matcher = ordered ? /^\d+[.)]\s+(.+)$/ : /^[-*+]\s+(.+)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(matcher);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <Tag key={`l-${blocks.length}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flush();
  return <>{blocks}</>;
}
function planSteps(plan: string): PlanStep[] {
  try {
    const parsed = JSON.parse(plan) as unknown;
    if (Array.isArray(parsed))
      return parsed.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const value = entry as { action?: unknown; context?: unknown };
        return typeof value.action === "string" && value.action.trim()
          ? [
              {
                action: value.action.trim(),
                context:
                  typeof value.context === "string" ? value.context.trim() : "",
              },
            ]
          : [];
      });
  } catch {
    /* legacy plans */
  }
  return plan
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*+])\s*/, "").trim())
    .filter(Boolean)
    .map((action) => ({ action }));
}

export function CourseCalendarView({
  course,
  aiEnabled,
  onEnsureAiModel,
  onToast,
}: {
  course: CourseClass;
  aiEnabled: boolean;
  onEnsureAiModel: () => Promise<string | null>;
  onToast: Toast;
}) {
  const [calendar, setCalendar] = useState<CourseCalendarDetail>(() =>
    emptyCalendar(course.id),
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<AiProgress>({
    progress: 3,
    message: "Preparing Course Calendar",
  });
  const [selected, setSelected] = useState<CourseCalendarItem | null>(null);
  const [reading, setReading] = useState<CourseCalendarSource | null>(null);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [manualDraft, setManualDraft] = useState<ManualDraft | null>(null);
  const [savingManual, setSavingManual] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCalendar(await api.getCourseCalendar(course.id));
    } catch (error) {
      onToast(
        error instanceof Error
          ? error.message
          : "Course Calendar could not be opened.",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [course.id, onToast]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AiProgress>("ai-generation-progress", (event) =>
      setRefreshProgress(event.payload),
    ).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, []);
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => {
        const date = new Date(weekStart);
        date.setDate(weekStart.getDate() + index);
        return { date, iso: isoDate(date) };
      }),
    [weekStart],
  );
  const itemSource =
    selected && !selected.isManual
      ? calendar.sources.find((source) => source.id === selected.sourceId)
      : null;
  const today = isoDate(new Date());
  const addDocuments = async () => {
    const remaining = 10 - calendar.sources.length;
    if (remaining <= 0) {
      onToast(
        "This Course Calendar already has 10 source documents. Remove one before adding another.",
        "error",
      );
      return;
    }
    const picked = await open({
      title: "Add course documents",
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Course documents",
          extensions: ["pdf", "doc", "docx", "pptx"],
        },
      ],
    });
    const paths = (
      Array.isArray(picked) ? picked : picked ? [picked] : []
    ).slice(0, remaining);
    if (!paths.length) return;
    try {
      const modelPath = await onEnsureAiModel();
      if (!modelPath) return;
      for (const path of paths) {
        const extracted = /\.docx?$/i.test(path)
          ? await api.importWordText(path)
          : /\.pptx$/i.test(path)
            ? await api.importPowerPointText(path)
            : await api.importPdfText(path);
        const title =
          path
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.[^.]+$/, "") || "Course document";
        await api.addCourseCalendarSource({
          classId: course.id,
          title,
          contentPlain: extracted,
          sourcePath: path,
        });
      }
      setCalendar(await api.getCourseCalendar(course.id));
      setRefreshing(true);
      setRefreshProgress({ progress: 3, message: "Preparing Course Calendar" });
      try {
        setCalendar(await api.refreshCourseCalendar(course.id, modelPath));
        onToast(
          `${paths.length} course document${paths.length === 1 ? "" : "s"} added and mapped to your calendar.`,
        );
      } catch (error) {
        onToast(
          `${paths.length} course document${paths.length === 1 ? "" : "s"} saved. ${error instanceof Error ? error.message : "Refresh AI could not build the calendar yet."}`,
          "error",
        );
      } finally {
        setRefreshing(false);
      }
    } catch (error) {
      onToast(
        error instanceof Error
          ? error.message
          : "That course document could not be added.",
        "error",
      );
    }
  };
  const refresh = async () => {
    if (!calendar.sources.length) {
      onToast("Add one or more course documents first.", "error");
      return;
    }
    setRefreshing(true);
    setRefreshProgress({ progress: 3, message: "Preparing Course Calendar" });
    try {
      const modelPath = await onEnsureAiModel();
      if (!modelPath) return;
      setCalendar(await api.refreshCourseCalendar(course.id, modelPath));
      setSelected(null);
      onToast("Course Calendar refreshed.");
    } catch (error) {
      onToast(
        error instanceof Error
          ? error.message
          : "Course Calendar could not be refreshed.",
        "error",
      );
    } finally {
      setRefreshing(false);
    }
  };
  const removeSource = async (source: CourseCalendarSource) => {
    try {
      await api.removeCourseCalendarSource(source.id);
      if (selected?.sourceId === source.id) setSelected(null);
      await load();
      onToast("Course document removed.");
    } catch (error) {
      onToast(
        error instanceof Error
          ? error.message
          : "Course document could not be removed.",
        "error",
      );
    }
  };
  const toggleItem = async (item: CourseCalendarItem) => {
    try {
      await api.setCourseCalendarItemCompleted(item.id, !item.completed);
      setCalendar((current) => ({
        ...current,
        items: current.items.map((entry) =>
          entry.id === item.id
            ? { ...entry, completed: !entry.completed }
            : entry,
        ),
      }));
      setSelected((current) =>
        current?.id === item.id
          ? { ...current, completed: !item.completed }
          : current,
      );
    } catch (error) {
      onToast(
        error instanceof Error
          ? error.message
          : "Completion could not be updated.",
        "error",
      );
    }
  };
  const saveManual = async () => {
    if (!manualDraft) return;
    setSavingManual(true);
    try {
      setCalendar(
        await api.saveCourseCalendarManualItem({
          classId: course.id,
          ...manualDraft,
          startTime: manualDraft.startTime || null,
          description: manualDraft.description || null,
        }),
      );
      setManualDraft(null);
      onToast("Calendar event saved.");
    } catch (error) {
      onToast(
        error instanceof Error
          ? error.message
          : "Calendar event could not be saved.",
        "error",
      );
    } finally {
      setSavingManual(false);
    }
  };
  const archiveManual = async () => {
    if (!selected?.isManual) return;
    try {
      await api.archiveCourseCalendarManualItem(selected.id);
      setCalendar((current) => ({
        ...current,
        items: current.items.filter((item) => item.id !== selected.id),
      }));
      setSelected(null);
      onToast("Calendar event archived.");
    } catch (error) {
      onToast(
        error instanceof Error
          ? error.message
          : "Calendar event could not be archived.",
        "error",
      );
    }
  };
  if (reading)
    return (
      <section className="course-calendar-source-page">
        <button
          className="button button-quiet button-small"
          onClick={() => setReading(null)}
        >
          <ArrowLeft size={15} /> Back to Course Calendar
        </button>
        <p className="eyebrow">COURSE SOURCE · READ ONLY</p>
        <h2>{reading.title}</h2>
        <p className="course-calendar-source-note">
          Saved with this class and used by Course Calendar.
        </p>
        <article className="course-calendar-source-document">
          <MarkdownBlocks text={reading.contentPlain} />
        </article>
      </section>
    );
  if (loading)
    return (
      <div className="content-loading">
        <i />
        Loading Course Calendar…
      </div>
    );
  return (
    <section className="course-calendar">
      <header className="course-calendar-heading">
        <div>
          <p className="eyebrow">
            {aiEnabled ? "AI COURSE PLANNER" : "COURSE PLANNER"}
          </p>
          <h2>Course Calendar</h2>
          <p>
            Track all your assignment deadlines with imported course documents.
          </p>
        </div>
        <div className="course-calendar-actions">
          {aiEnabled && (
            <>
              <button
                className="button button-soft button-small ai-action"
                onClick={() => void addDocuments()}
                disabled={refreshing}
              >
                <FileUp size={15} /> Add course documents
              </button>
              <button
                className="button button-primary button-small ai-action"
                disabled={!calendar.sources.length || refreshing}
                onClick={() => void refresh()}
              >
                <RefreshCw size={15} className={refreshing ? "spin" : ""} />{" "}
                {refreshing ? "Refreshing…" : "Refresh AI"}
              </button>
            </>
          )}
          <button
            className="button button-soft button-small course-calendar-add course-calendar-add-icon"
            onClick={() => setManualDraft(newManualDraft())}
            aria-label="Add calendar event"
            title="Add calendar event"
          >
            <Plus size={18} />
          </button>
        </div>
      </header>
      <div className="course-week-toolbar">
        <div>
          <button
            className="icon-button"
            aria-label="Previous week"
            onClick={() =>
              setWeekStart(
                (current) =>
                  new Date(
                    current.getFullYear(),
                    current.getMonth(),
                    current.getDate() - 7,
                  ),
              )
            }
          >
            <ChevronLeft size={18} />
          </button>
          <strong>{weekLabel(weekStart)}</strong>
          <button
            className="icon-button"
            aria-label="Next week"
            onClick={() =>
              setWeekStart(
                (current) =>
                  new Date(
                    current.getFullYear(),
                    current.getMonth(),
                    current.getDate() + 7,
                  ),
              )
            }
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <button
          className="text-button"
          onClick={() => setWeekStart(startOfWeek(new Date()))}
        >
          <RotateCcw size={14} /> Today
        </button>
      </div>
      <div
        className={`course-calendar-layout${aiEnabled ? "" : " calendar-only"}`}
      >
        <div className="course-week-schedule">
          <div className="course-time-rail">
            <span>Due</span>
            <span>9 AM</span>
            <span>11 AM</span>
            <span>1 PM</span>
            <span>3 PM</span>
            <span>5 PM</span>
            <span>7 PM</span>
          </div>
          <div className="course-week-days">
            {days.map(({ date, iso }) => {
              const events = calendar.items.filter(
                (item) => item.dueDate === iso,
              );
              return (
                <section
                  className={`course-week-day${iso === today ? " today" : ""}`}
                  key={iso}
                >
                  <header>
                    <small>
                      {date.toLocaleDateString(undefined, { weekday: "short" })}
                    </small>
                    <strong>{date.getDate()}</strong>
                  </header>
                  <div className="course-day-grid">
                    <div className="course-due-lane">
                      {events.map((item) => (
                        <button
                          key={item.id}
                          className={`course-calendar-event urgency-${item.urgency}${item.completed ? " completed" : ""}${item.isManual ? " manual-event" : ""}`}
                          style={
                            item.isManual && item.color
                              ? {
                                  backgroundColor: item.color,
                                  borderLeftColor: item.color,
                                }
                              : undefined
                          }
                          onClick={() => setSelected(item)}
                        >
                          <span>
                            {item.completed ? (
                              <Check size={13} />
                            ) : (
                              <CalendarDays size={13} />
                            )}
                          </span>
                          <strong>{item.title}</strong>
                          <small>
                            {item.completed
                              ? "Completed"
                              : item.startTime
                                ? item.startTime
                                : `Due ${item.dueDate}`}
                          </small>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        </div>
        {aiEnabled && (
          <aside className="course-calendar-sidebar">
            <section className="course-calendar-plan">
              <div>
                <p className="eyebrow">GAME PLAN</p>
                <h3>What to do first</h3>
              </div>
              {calendar.gamePlan ? (
                <ol>
                  {planSteps(calendar.gamePlan).map((step, index) => (
                    <li key={index}>{inline(step)}</li>
                  ))}
                </ol>
              ) : (
                <p>
                  {calendar.sources.length
                    ? "Refresh with AI to create a priority-aware plan from your course documents."
                    : "Add course documents, then SoFlo can build your plan."}
                </p>
              )}
            </section>
            <section className="course-calendar-sources">
              <div>
                <h3>Course documents</h3>
                <small>{calendar.sources.length}/10 saved</small>
              </div>
              {calendar.sources.length ? (
                calendar.sources.map((source) => (
                  <article key={source.id}>
                    <button onClick={() => setReading(source)}>
                      <FileText size={15} />
                      <span>{source.title}</span>
                    </button>
                    <button
                      className="icon-button tiny"
                      onClick={() => void removeSource(source)}
                      aria-label={`Remove ${source.title}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </article>
                ))
              ) : (
                <p>No saved documents yet.</p>
              )}
            </section>
          </aside>
        )}
      </div>
      {selected && (
        <div className="paper-dialog-backdrop">
          <section
            className="paper-dialog course-calendar-detail"
            role="dialog"
            aria-modal="true"
            aria-label="Course calendar item"
          >
            <header>
              <div>
                <p className="eyebrow">
                  {selected.isManual
                    ? "CUSTOM EVENT"
                    : `DUE ${selected.dueDate}`}
                </p>
                <h2>{selected.title}</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setSelected(null)}
                aria-label="Close"
              >
                <X size={17} />
              </button>
            </header>
            <div className="paper-dialog-content">
              {selected.startTime && (
                <p className="course-calendar-event-time">
                  {selected.dueDate} at {selected.startTime}
                </p>
              )}
              <p>
                {selected.description ||
                  (selected.isManual
                    ? "No additional details for this event."
                    : "Review the linked course document for the assignment details.")}
              </p>
              {selected.sourceExcerpt && (
                <blockquote>{selected.sourceExcerpt}</blockquote>
              )}
              {itemSource && (
                <button
                  className="text-button course-calendar-source-link"
                  onClick={() => {
                    setSelected(null);
                    setReading(itemSource);
                  }}
                >
                  Open {itemSource.title}
                  <ArrowLeft size={14} />
                </button>
              )}
            </div>
            <footer>
              {selected.isManual ? (
                <button
                  className="button button-soft button-small"
                  onClick={() => void archiveManual()}
                >
                  <Archive size={15} /> Archive
                </button>
              ) : (
                <button
                  className={`button button-small ${selected.completed ? "button-soft" : "button-primary"}`}
                  onClick={() => void toggleItem(selected)}
                >
                  {selected.completed ? (
                    "Mark incomplete"
                  ) : (
                    <>
                      <Check size={15} /> Mark complete
                    </>
                  )}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
      {manualDraft && (
        <div className="paper-dialog-backdrop">
          <section
            className="paper-dialog course-calendar-manual-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Add calendar event"
          >
            <header>
              <div>
                <p className="eyebrow">CUSTOM EVENT</p>
                <h2>Add to Course Calendar</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setManualDraft(null)}
                disabled={savingManual}
                aria-label="Close"
              >
                <X size={17} />
              </button>
            </header>
            <div className="paper-dialog-content course-calendar-manual-form">
              <label>
                Title
                <input
                  autoFocus
                  value={manualDraft.title}
                  onChange={(event) =>
                    setManualDraft({
                      ...manualDraft,
                      title: event.target.value,
                    })
                  }
                  placeholder="Assignment, study block, or event"
                />
              </label>
              <div className="course-calendar-manual-datetime">
                <label>
                  Date
                  <input
                    type="date"
                    value={manualDraft.dueDate}
                    onChange={(event) =>
                      setManualDraft({
                        ...manualDraft,
                        dueDate: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Time <span>optional</span>
                  <input
                    type="time"
                    value={manualDraft.startTime}
                    onChange={(event) =>
                      setManualDraft({
                        ...manualDraft,
                        startTime: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <label>
                Details <span>optional</span>
                <textarea
                  rows={4}
                  value={manualDraft.description}
                  onChange={(event) =>
                    setManualDraft({
                      ...manualDraft,
                      description: event.target.value,
                    })
                  }
                  placeholder="What do you need to remember?"
                />
              </label>
              <div>
                <small>Color</small>
                <div className="course-calendar-color-picker">
                  {eventColors.map((color) => (
                    <button
                      type="button"
                      key={color}
                      aria-label={`Use ${color}`}
                      className={manualDraft.color === color ? "selected" : ""}
                      style={{ backgroundColor: color }}
                      onClick={() => setManualDraft({ ...manualDraft, color })}
                    >
                      <Check size={13} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <footer>
              <button
                className="button button-quiet button-small"
                onClick={() => setManualDraft(null)}
                disabled={savingManual}
              >
                Cancel
              </button>
              <button
                className="button button-primary button-small"
                onClick={() => void saveManual()}
                disabled={savingManual || !manualDraft.title.trim()}
              >
                {savingManual ? "Saving…" : "Add event"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {refreshing && (
        <div
          className="ai-consent-backdrop ai-progress-backdrop"
          role="presentation"
        >
          <section
            className="ai-consent-card ai-download-card ai-progress-card"
            role="status"
            aria-live="polite"
          >
            <i className="ai-progress-spinner" />
            <p className="eyebrow">SOFLO AI IS WORKING</p>
            <h2>Refreshing Course Calendar</h2>
            <p>{refreshProgress.message}</p>
            <div className="ai-download-track">
              <i style={{ width: `${refreshProgress.progress}%` }} />
            </div>
            <strong>{refreshProgress.progress}% complete</strong>
          </section>
        </div>
      )}
    </section>
  );
}
