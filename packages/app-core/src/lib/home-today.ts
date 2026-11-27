import type { CalendarMeeting } from '@zennotes/bridge-contract/calendar'
import { meetingDay } from '@shared/meeting-notes'
import { noteTitleForDate } from './vault-layout'

/**
 * What Home shows about the day: the meetings on it, in the order they
 * happen, and the one line under the date ("3 tasks today · 2 meetings
 * ahead"), as the older Zotly app's home did. Pure, so it is tested apart
 * from the view.
 */

/** The meetings on the viewer's local day `now` falls on: all-day ones first,
 *  then by start, then by title. A meeting that spans days shows on its first
 *  day only, as in the Calendar panel. */
export function meetingsOnDay(meetings: readonly CalendarMeeting[], now: Date): CalendarMeeting[] {
  const day = noteTitleForDate(now)
  return meetings
    .filter((meeting) => meetingDay(meeting) === day)
    .slice()
    .sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
      if (a.start !== b.start) return a.start < b.start ? -1 : 1
      return a.title.localeCompare(b.title)
    })
}

/** Timed meetings that have not started yet. All-day ones never count. */
export function meetingsAhead(meetings: readonly CalendarMeeting[], now: Date): number {
  const at = now.getTime()
  return meetings.filter((meeting) => !meeting.allDay && Date.parse(meeting.start) > at).length
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The line under Home's date. */
export function daySummary(input: { openTasks: number; overdue: number; meetingsAhead: number }): string {
  const parts: string[] = []
  if (input.openTasks > 0) {
    parts.push(
      input.overdue > 0
        ? `${plural(input.openTasks, 'task')} today, ${input.overdue} overdue`
        : `${plural(input.openTasks, 'task')} today`
    )
  }
  if (input.meetingsAhead > 0) parts.push(`${plural(input.meetingsAhead, 'meeting')} ahead`)
  return parts.length > 0 ? parts.join(' · ') : 'Nothing scheduled. A clear day.'
}

/** The first few lines of a daily note's excerpt, for the Today card. */
export function dailyNotePreview(excerpt: string, max = 160): string {
  const text = excerpt.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** Milliseconds until the next local midnight, so Home turns the day over
 *  when it is left open overnight. */
export function msUntilNextDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return Math.max(1000, next.getTime() - now.getTime())
}
