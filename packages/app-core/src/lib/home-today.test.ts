import { describe, expect, it } from 'vitest'
import type { CalendarMeeting } from '@zennotes/bridge-contract/calendar'
import { dailyNotePreview, daySummary, meetingsAhead, meetingsOnDay, msUntilNextDay } from './home-today'

function meeting(key: string, start: string, end: string, extra: Partial<CalendarMeeting> = {}): CalendarMeeting {
  return {
    uid: key,
    key,
    title: key,
    start,
    end,
    allDay: false,
    location: null,
    description: null,
    url: null,
    organizer: null,
    attendees: [],
    recurring: false,
    feedId: 'f',
    feedName: 'Work',
    ...extra
  }
}

const local = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString()

describe('meetingsOnDay', () => {
  const now = new Date(2026, 10, 27, 10, 0)
  const list = [
    meeting('lunch', local(2026, 11, 27, 12), local(2026, 11, 27, 13)),
    meeting('standup', local(2026, 11, 27, 9), local(2026, 11, 27, 9, 15)),
    meeting('offsite', '2026-11-27', '2026-11-28', { allDay: true }),
    meeting('tomorrow', local(2026, 11, 28, 9), local(2026, 11, 28, 10)),
    meeting('yesterday', local(2026, 11, 26, 9), local(2026, 11, 26, 10))
  ]

  it("keeps the viewer's day only: all-day first, then by start", () => {
    expect(meetingsOnDay(list, now).map((m) => m.key)).toEqual(['offsite', 'standup', 'lunch'])
  })

  it('counts timed meetings that have not started as ahead', () => {
    expect(meetingsAhead(meetingsOnDay(list, now), now)).toBe(1)
  })
})

describe('daySummary', () => {
  it('names tasks, overdue ones and meetings ahead', () => {
    expect(daySummary({ openTasks: 3, overdue: 1, meetingsAhead: 2 })).toBe('3 tasks today, 1 overdue · 2 meetings ahead')
    expect(daySummary({ openTasks: 1, overdue: 0, meetingsAhead: 0 })).toBe('1 task today')
    expect(daySummary({ openTasks: 0, overdue: 0, meetingsAhead: 1 })).toBe('1 meeting ahead')
  })

  it('says the day is clear when nothing is on it', () => {
    expect(daySummary({ openTasks: 0, overdue: 0, meetingsAhead: 0 })).toBe('Nothing scheduled. A clear day.')
  })
})

describe('dailyNotePreview', () => {
  it('folds whitespace and cuts long text at a word', () => {
    expect(dailyNotePreview('  one\n\ntwo  ')).toBe('one two')
    const long = 'word '.repeat(60)
    const cut = dailyNotePreview(long, 40)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(41)
    expect(cut).not.toMatch(/wor…$/)
  })
})

describe('msUntilNextDay', () => {
  it('is the time to the next local midnight', () => {
    expect(msUntilNextDay(new Date(2026, 10, 27, 23, 0))).toBe(60 * 60 * 1000)
  })
})
