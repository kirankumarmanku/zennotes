import { useEffect, useState } from 'react'
import type { NoteMeta } from '@shared/ipc'
import type { CalendarMeeting, CalendarMeetingsResult } from '@zennotes/bridge-contract/calendar'
import type { CalendarEvent } from '@shared/calendar-ics'
import { DEFAULT_MEETING_NOTES_FOLDER, meetingDay, meetingNoteTitle } from '@shared/meeting-notes'
import { noteFolderSubpath, type normalizeVaultSettings } from './vault-layout'

/** Sent on window when a calendar is added or removed, so open panels re-read. */
export const CALENDAR_FEEDS_CHANGED_EVENT = 'zen:calendar-feeds-changed'

const REFRESH_MS = 5 * 60_000

/** Whether this host can read calendars (the desktop app). */
export function calendarFeedsSupported(): boolean {
  return typeof window.zen?.calendarMeetings === 'function'
}

/** The note a meeting already has, matched by its stable name in Inbox/Meetings. */
export function findMeetingNote(
  notes: NoteMeta[],
  settings: ReturnType<typeof normalizeVaultSettings>,
  meeting: CalendarEvent
): NoteMeta | null {
  const title = meetingNoteTitle(meeting)
  return (
    notes.find(
      (note) =>
        note.folder === 'inbox' &&
        note.title === title &&
        noteFolderSubpath(note, settings) === DEFAULT_MEETING_NOTES_FOLDER
    ) ?? null
  )
}

/** Meetings grouped by the viewer's local day, `YYYY-MM-DD`. Multi-day
 *  meetings show on their first day only. */
export function groupMeetingsByDay(meetings: CalendarMeeting[]): Map<string, CalendarMeeting[]> {
  const out = new Map<string, CalendarMeeting[]>()
  for (const meeting of meetings) {
    const day = meetingDay(meeting)
    const list = out.get(day)
    if (list) list.push(meeting)
    else out.set(day, [meeting])
  }
  return out
}

/** `9:30 AM`, or `All day`. */
export function meetingTimeLabel(meeting: CalendarEvent): string {
  if (meeting.allDay) return 'All day'
  return new Date(meeting.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export interface CalendarMeetingsState {
  meetings: CalendarMeeting[]
  failures: CalendarMeetingsResult['failures']
  loading: boolean
}

const EMPTY: CalendarMeetingsState = { meetings: [], failures: [], loading: false }

/**
 * Meetings between two local days (inclusive), read through the host. Empty
 * where the host has no calendars. Re-reads every few minutes and when a
 * calendar is added or removed.
 */
export function useCalendarMeetings(fromDay: Date, toDay: Date): CalendarMeetingsState {
  const [state, setState] = useState<CalendarMeetingsState>(EMPTY)
  const [nonce, setNonce] = useState(0)
  const fromIso = new Date(fromDay.getFullYear(), fromDay.getMonth(), fromDay.getDate()).toISOString()
  const toIso = new Date(toDay.getFullYear(), toDay.getMonth(), toDay.getDate() + 1).toISOString()

  useEffect(() => {
    if (!calendarFeedsSupported()) return
    const bump = (): void => setNonce((n) => n + 1)
    const timer = setInterval(bump, REFRESH_MS)
    window.addEventListener(CALENDAR_FEEDS_CHANGED_EVENT, bump)
    return () => {
      clearInterval(timer)
      window.removeEventListener(CALENDAR_FEEDS_CHANGED_EVENT, bump)
    }
  }, [])

  useEffect(() => {
    const read = window.zen?.calendarMeetings
    if (!read) return
    let live = true
    setState((current) => ({ ...current, loading: true }))
    read(fromIso, toIso)
      .then((result) => {
        if (live) setState({ meetings: result.meetings, failures: result.failures, loading: false })
      })
      .catch((error: unknown) => {
        if (!live) return
        const message = error instanceof Error ? error.message : String(error)
        setState({ meetings: [], failures: [{ feedId: '', feedName: 'Calendars', message }], loading: false })
      })
    return () => {
      live = false
    }
  }, [fromIso, toIso, nonce])

  return state
}
