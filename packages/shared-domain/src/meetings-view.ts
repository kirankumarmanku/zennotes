/**
 * The built-in Meetings view: every meeting note of the vault, the latest
 * meeting first.
 *
 * A meeting note's time is its meeting's own start, read from the note:
 *
 *   1. `event_start` in its frontmatter (what `meetingNoteBody` writes);
 *   2. otherwise the `YYYY-MM-DD HHMM` (or all-day `YYYY-MM-DD`) that starts
 *      its name, which `meetingNoteTitle` writes in the viewer's local time;
 *   3. otherwise, for a note in the Meetings folder with neither, the time
 *      the file was created, so it still lists and says so.
 */
import { FRONTMATTER_BLOCK_RE, parseFrontmatterFields } from './frontmatter'

/** Virtual tab path of the Meetings view; `zen://` never collides with a note. */
export const MEETINGS_TAB_PATH = 'zen://meetings'

/** True when `path` points at the built-in Meetings tab. */
export function isMeetingsTabPath(path: string | null | undefined): boolean {
  return path === MEETINGS_TAB_PATH
}

/** Where a meeting note's listed time came from. */
export type MeetingTimeSource = 'note' | 'title' | 'file'

export interface MeetingTime {
  /** Epoch ms of the meeting's start (local midnight for an all-day one). */
  start: number
  allDay: boolean
  source: MeetingTimeSource
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TITLE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):?(\d{2}))?(?=\s|$)/

function localDate(y: string, m: string, d: string, hh = '0', mm = '0'): number | null {
  const year = Number(y)
  const month = Number(m)
  const day = Number(d)
  const hour = Number(hh)
  const minute = Number(mm)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  const date = new Date(year, month - 1, day, hour, minute)
  // Reject dates that rolled over (2026-02-31 -> Mar 3).
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date.getTime()
}

/** The meeting fields of a note's frontmatter, or null when it has none. */
export function meetingFrontmatter(
  noteBody: string
): { type: string | null; start: string | null; title: string | null } | null {
  const block = FRONTMATTER_BLOCK_RE.exec(noteBody)
  if (!block) return null
  const fields = parseFrontmatterFields(block[1])
  const text = (key: string): string | null => {
    const value = fields[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  return { type: text('type'), start: text('event_start'), title: text('event_title') }
}

/** `event_start` as epoch ms: an ISO instant, or a `YYYY-MM-DD` all-day date. */
export function parseMeetingStart(value: string): { start: number; allDay: boolean } | null {
  const dateOnly = DATE_ONLY_RE.exec(value)
  if (dateOnly) {
    const start = localDate(dateOnly[1], dateOnly[2], dateOnly[3])
    return start === null ? null : { start, allDay: true }
  }
  // Only full dates with a time: Date.parse takes far looser text otherwise.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null
  const start = Date.parse(value)
  return Number.isNaN(start) ? null : { start, allDay: false }
}

/** The meeting time a note's name starts with (`2026-11-25 1500 Design review`). */
export function meetingTimeFromTitle(title: string): { start: number; allDay: boolean } | null {
  const match = TITLE_TIME_RE.exec(title.trim())
  if (!match) return null
  const [, y, m, d, hh, mm] = match
  const allDay = hh === undefined
  const start = allDay ? localDate(y, m, d) : localDate(y, m, d, hh, mm)
  return start === null ? null : { start, allDay }
}

/** A meeting note's time, from the note's own data first. `eventStart` is its
 *  frontmatter `event_start` (see `meetingFrontmatter`), when it has one. */
export function meetingNoteTime(
  note: { title: string; createdAt: number },
  eventStart: string | null
): MeetingTime {
  const fromNote = eventStart ? parseMeetingStart(eventStart) : null
  if (fromNote) return { ...fromNote, source: 'note' }
  const fromTitle = meetingTimeFromTitle(note.title)
  if (fromTitle) return { ...fromTitle, source: 'title' }
  return { start: note.createdAt, allDay: false, source: 'file' }
}

/** Latest meeting first; same start: the more recently edited note first, then by name. */
export function sortMeetingsLatestFirst<T extends { time: MeetingTime; note: { title: string; updatedAt: number } }>(
  rows: readonly T[]
): T[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        b.time.start - a.time.start ||
        b.note.updatedAt - a.note.updatedAt ||
        a.note.title.localeCompare(b.note.title)
    )
}
