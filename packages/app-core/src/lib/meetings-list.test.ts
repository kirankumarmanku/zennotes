import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { buildMeetingRows, factsFromBody, isMeetingNote } from './meetings-list'
import { normalizeVaultSettings } from './vault-layout'
import { meetingDayLabel } from '../components/MeetingsView'

function note(path: string, extra: Partial<NoteMeta> = {}): NoteMeta {
  const title = path.split('/').pop()!.replace(/\.md$/, '')
  return {
    path, title, folder: 'inbox', siblingOrder: 0, createdAt: 0, updatedAt: 0, size: 0,
    tags: [], wikilinks: [], assetEmbeds: [], hasAttachments: false, excerpt: '', ...extra
  } as NoteMeta
}

const front = (start: string, title: string): string =>
  `---\ntype: meeting\nevent_start: ${start}\nevent_title: ${title}\n---\n\n# ${title}\n`

describe('meetings list', () => {
  it('takes notes in Inbox/Meetings and folders inside it only', () => {
    const settings = normalizeVaultSettings(null)
    expect(isMeetingNote(note('inbox/Meetings/2026-11-25 1500 Design review.md'), settings)).toBe(true)
    expect(isMeetingNote(note('inbox/Meetings/2025/Old one.md'), settings)).toBe(true)
    expect(isMeetingNote(note('inbox/Meetingsish/x.md'), settings)).toBe(false)
    expect(isMeetingNote(note('inbox/2026-11-25 1500 Design review.md'), settings)).toBe(false)
    expect(isMeetingNote(note('archive/Meetings/x.md', { folder: 'archive' }), settings)).toBe(false)
  })

  it('orders by meeting start from the note, then the name, then the file, latest first', () => {
    const renamed = note('inbox/Meetings/Renamed review.md', { updatedAt: 1 })
    const titled = note('inbox/Meetings/2026-11-24 0900 Standup.md')
    const loose = note('inbox/Meetings/Loose notes.md', { createdAt: new Date(2026, 10, 20).getTime() })
    const future = note('inbox/Meetings/2026-11-30 1000 Planning.md')
    const bodies: Record<string, string> = {
      [renamed.path]: front(new Date(2026, 10, 25, 15).toISOString(), 'Design review'),
      // The frontmatter wins over the name when the two disagree.
      [future.path]: front(new Date(2026, 10, 23, 10).toISOString(), 'Planning')
    }
    const rows = buildMeetingRows([titled, loose, renamed, future], (n) =>
      bodies[n.path] ? factsFromBody(bodies[n.path]) : null
    )
    expect(rows.map((r) => [r.title, r.time.source])).toEqual([
      ['Design review', 'note'],
      ['Standup', 'title'],
      ['Planning', 'note'],
      ['Loose notes', 'file']
    ])
  })

  it('labels days around today', () => {
    const now = new Date(2026, 10, 26, 12)
    expect(meetingDayLabel(new Date(2026, 10, 26, 9).getTime(), now)).toBe('Today')
    expect(meetingDayLabel(new Date(2026, 10, 25, 23).getTime(), now)).toBe('Yesterday')
    expect(meetingDayLabel(new Date(2026, 10, 27, 1).getTime(), now)).toBe('Tomorrow')
    expect(meetingDayLabel(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/)
  })
})
