import { describe, expect, it } from 'vitest'
import { meetingNoteBody } from './meeting-notes'
import {
  MEETINGS_TAB_PATH,
  isMeetingsTabPath,
  meetingFrontmatter,
  meetingNoteTime,
  meetingTimeFromTitle,
  parseMeetingStart,
  sortMeetingsLatestFirst
} from './meetings-view'

const event = {
  uid: 'u1',
  key: 'u1@2026-11-25T15:00:00.000Z',
  title: 'Design review',
  start: '2026-11-25T15:00:00.000Z',
  end: '2026-11-25T16:00:00.000Z',
  allDay: false,
  location: null,
  description: null,
  url: null,
  organizer: null,
  attendees: [],
  recurring: false
}

describe('meetings view', () => {
  it('has its own virtual tab', () => {
    expect(isMeetingsTabPath(MEETINGS_TAB_PATH)).toBe(true)
    expect(isMeetingsTabPath('inbox/Meetings/x.md')).toBe(false)
    expect(isMeetingsTabPath(null)).toBe(false)
  })

  it('reads the meeting start and title a meeting note is written with', () => {
    const body = meetingNoteBody(event as never)
    expect(meetingFrontmatter(body)).toEqual({
      type: 'meeting',
      start: '2026-11-25T15:00:00.000Z',
      title: 'Design review'
    })
    expect(meetingFrontmatter('# Just a note\n')).toBeNull()
  })

  it('parses instants and all-day dates, and refuses loose text', () => {
    expect(parseMeetingStart('2026-11-25T15:00:00.000Z')).toEqual({ start: Date.UTC(2026, 10, 25, 15), allDay: false })
    expect(parseMeetingStart('2026-11-26')).toEqual({ start: new Date(2026, 10, 26).getTime(), allDay: true })
    expect(parseMeetingStart('next tuesday')).toBeNull()
    expect(parseMeetingStart('2026-02-31')).toBeNull()
  })

  it('reads the local time a meeting note name starts with', () => {
    expect(meetingTimeFromTitle('2026-11-25 1500 Design review')).toEqual({
      start: new Date(2026, 10, 25, 15, 0).getTime(),
      allDay: false
    })
    expect(meetingTimeFromTitle('2026-11-26 Offsite')).toEqual({ start: new Date(2026, 10, 26).getTime(), allDay: true })
    expect(meetingTimeFromTitle('Design review')).toBeNull()
    expect(meetingTimeFromTitle('2026-11-25 2561 Bad')).toBeNull()
  })

  it('prefers the note frontmatter, then its name, then the file', () => {
    const note = { title: '2026-11-25 0900 Standup', createdAt: 5 }
    expect(meetingNoteTime(note, '2026-11-25T15:00:00.000Z').source).toBe('note')
    expect(meetingNoteTime(note, null)).toEqual({ start: new Date(2026, 10, 25, 9).getTime(), allDay: false, source: 'title' })
    expect(meetingNoteTime(note, 'garbage').source).toBe('title')
    expect(meetingNoteTime({ title: 'Loose notes', createdAt: 5 }, null)).toEqual({ start: 5, allDay: false, source: 'file' })
  })

  it('sorts the latest meeting first', () => {
    const row = (title: string, start: number, updatedAt = 0) => ({
      note: { title, updatedAt },
      time: { start, allDay: false, source: 'note' as const }
    })
    const sorted = sortMeetingsLatestFirst([row('a', 1), row('c', 3), row('b', 2), row('b2', 2, 9)])
    expect(sorted.map((r) => r.note.title)).toEqual(['c', 'b2', 'b', 'a'])
  })
})
