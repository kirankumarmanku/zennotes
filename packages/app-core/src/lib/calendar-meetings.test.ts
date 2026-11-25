import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import type { CalendarMeeting } from '@zennotes/bridge-contract/calendar'
import { meetingNoteTitle } from '@shared/meeting-notes'
import { findMeetingNote, groupMeetingsByDay } from './calendar-meetings'
import { normalizeVaultSettings } from './vault-layout'

function meeting(start: string, end: string, title: string, allDay = false): CalendarMeeting {
  return {
    uid: title, key: `${title}@${start}`, title, start, end, allDay, location: null, description: null,
    url: null, organizer: null, attendees: [], recurring: false, feedId: 'f', feedName: 'Work',
  }
}

function note(path: string): NoteMeta {
  const title = path.split('/').pop()!.replace(/\.md$/, '')
  return { path, title, folder: 'inbox', siblingOrder: 0, createdAt: 0, updatedAt: 0, size: 0, tags: [], wikilinks: [] } as unknown as NoteMeta
}

describe('calendar meetings in the app', () => {
  it('groups meetings by their local day, all-day ones by their date', () => {
    const local = new Date(2026, 10, 25, 10, 0).toISOString()
    const later = new Date(2026, 10, 25, 11, 0).toISOString()
    const groups = groupMeetingsByDay([
      meeting(local, later, 'Design review'),
      meeting('2026-11-26', '2026-11-27', 'Offsite', true),
    ])
    expect(groups.get('2026-11-25')?.map((m) => m.title)).toEqual(['Design review'])
    expect(groups.get('2026-11-26')?.map((m) => m.title)).toEqual(['Offsite'])
  })

  it('finds a meeting’s note only in Inbox/Meetings', () => {
    const settings = normalizeVaultSettings(null)
    const event = meeting(new Date(2026, 10, 25, 10, 0).toISOString(), new Date(2026, 10, 25, 11, 0).toISOString(), 'Design review')
    const title = meetingNoteTitle(event)
    expect(findMeetingNote([note(`inbox/${title}.md`)], settings, event)).toBeNull()
    const inMeetings = note(`inbox/Meetings/${title}.md`)
    expect(findMeetingNote([note(`inbox/${title}.md`), inMeetings], settings, event)).toBe(inMeetings)
  })
})
