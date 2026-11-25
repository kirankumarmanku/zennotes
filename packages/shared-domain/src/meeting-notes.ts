/**
 * A note for a meeting: one per meeting instance, named by its day, time and
 * title, with the meeting's facts in flat frontmatter so search, databases and
 * the task scanner can read them:
 *
 *   ---
 *   type: meeting
 *   event_key: 7kq…@google.com@2026-11-25T15:00:00.000Z
 *   event_title: Design review
 *   event_start: 2026-11-25T15:00:00.000Z
 *   event_end: 2026-11-25T16:00:00.000Z
 *   location: Room 4
 *   organizer: Priya <priya@example.com>
 *   attendees:
 *     - Priya <priya@example.com>
 *     - Dev
 *   ---
 *
 * The note only reads the calendar. Nothing here sends or changes an invite.
 */
import type { CalendarEvent, CalendarPerson } from './calendar-ics'
import { FRONTMATTER_BLOCK_RE, parseFrontmatterFields, yamlValue } from './frontmatter'

export const DEFAULT_MEETING_NOTES_FOLDER = 'Meetings'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Wall-clock parts of an instant in a zone (the viewer's by default). */
function localParts(iso: string, timeZone?: string): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(new Date(iso))) parts[part.type] = part.value
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}${parts.minute}` }
}

/** The meeting's local day, `YYYY-MM-DD`. */
export function meetingDay(event: CalendarEvent, timeZone?: string): string {
  return event.allDay ? event.start : localParts(event.start, timeZone).date
}

/** Characters no file system takes, and ones that break wikilinks. */
function cleanTitle(title: string): string {
  return title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
}

/** `2026-11-25 1500 Design review`: sorts by time inside the folder, and stays
 *  the same name however often the calendar is read. */
export function meetingNoteTitle(event: CalendarEvent, timeZone?: string): string {
  const name = cleanTitle(event.title) || 'Meeting'
  if (event.allDay) return `${event.start} ${name}`
  const { date, time } = localParts(event.start, timeZone)
  return `${date} ${time} ${name}`
}

export function formatPerson(person: CalendarPerson): string {
  if (person.name && person.email && person.name !== person.email) return `${person.name} <${person.email}>`
  return person.name ?? person.email ?? ''
}

/** Attendees once each, the organizer left to their own field. */
function attendeeLines(event: CalendarEvent): string[] {
  const seen = new Set<string>()
  const organizer = event.organizer?.email?.toLowerCase() ?? null
  const out: string[] = []
  for (const attendee of event.attendees) {
    const key = (attendee.email ?? attendee.name ?? '').toLowerCase()
    if (!key || seen.has(key) || (organizer && key === organizer)) continue
    seen.add(key)
    out.push(formatPerson(attendee))
  }
  return out
}

function timeRange(event: CalendarEvent, timeZone?: string): string {
  if (event.allDay) return `${event.start} (all day)`
  const options: Intl.DateTimeFormatOptions = {
    ...(timeZone ? { timeZone } : {}),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }
  const start = new Date(event.start)
  const end = new Date(event.end)
  const sameDay = meetingDay(event, timeZone) === localParts(event.end, timeZone).date
  const endText = end.toLocaleTimeString('en-US', {
    ...(timeZone ? { timeZone } : {}),
    hour: 'numeric',
    minute: '2-digit',
    ...(sameDay ? {} : { weekday: 'short', month: 'short', day: 'numeric' })
  })
  return `${start.toLocaleString('en-US', options)} to ${endText}`
}

/**
 * The new note's text. `extra` lets a vault template's body follow the
 * header, so a person's own meeting layout wins over the default sections.
 */
export function meetingNoteBody(event: CalendarEvent, options: { timeZone?: string; template?: string } = {}): string {
  const attendees = attendeeLines(event)
  const front = [
    '---',
    'type: meeting',
    `event_key: ${yamlValue(event.key)}`,
    `event_title: ${yamlValue(event.title)}`,
    `event_start: ${yamlValue(event.start)}`,
    `event_end: ${yamlValue(event.end)}`,
    ...(event.location ? [`location: ${yamlValue(event.location)}`] : []),
    ...(event.organizer ? [`organizer: ${yamlValue(formatPerson(event.organizer))}`] : []),
    ...(attendees.length ? ['attendees:', ...attendees.map((a) => `  - ${yamlValue(a)}`)] : []),
    '---'
  ]
  const facts = [
    `**When:** ${timeRange(event, options.timeZone)}`,
    ...(event.location ? [`**Where:** ${event.location}`] : []),
    ...(event.organizer ? [`**Organizer:** ${formatPerson(event.organizer)}`] : []),
    ...(attendees.length ? [`**With:** ${attendees.join(', ')}`] : [])
  ]
  const body = options.template?.trim()
    ? options.template.trim()
    : ['## Agenda', '', '- ', '', '## Notes', '', '- ', '', '## Action items', '', '- [ ] '].join('\n')
  return `${front.join('\n')}\n\n# ${event.title}\n\n${facts.join('  \n')}\n\n${body}\n`
}

/** The `event_key` of a note's frontmatter, or null when it is not a meeting note. */
export function meetingNoteKey(noteBody: string): string | null {
  const block = FRONTMATTER_BLOCK_RE.exec(noteBody)
  if (!block) return null
  const value = parseFrontmatterFields(block[1]).event_key
  return typeof value === 'string' && value ? value : null
}
