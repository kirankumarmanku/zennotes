import { describe, expect, it } from 'vitest'
import { readCalendarEvents, resolveTimeZone } from './calendar-ics'
import { meetingDay, meetingNoteBody, meetingNoteKey, meetingNoteTitle } from './meeting-notes'

function feed(...events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events, 'END:VCALENDAR'].join('\r\n')
}

const window = (from: string, to: string, defaultTimeZone = 'America/New_York') => ({
  from: new Date(from),
  to: new Date(to),
  defaultTimeZone
})

describe('readCalendarEvents', () => {
  it('reads a timed meeting with its people, unfolding long lines and unescaping text', () => {
    const text = feed(
      'BEGIN:VEVENT',
      'UID:abc@google.com',
      'DTSTART;TZID=America/New_York:20261125T100000',
      'DTEND;TZID=America/New_York:20261125T110000',
      'SUMMARY:Design review\\, round 2',
      'LOCATION:Room 4',
      'DESCRIPTION:Bring the\\nmockups',
      'ORGANIZER;CN=Priya Shah:mailto:priya@example.com',
      'ATTENDEE;CN="Dev, Ops";PARTSTAT=ACCEPTED:mailto:dev@exa',
      ' mple.com',
      'ATTENDEE;CN=Priya Shah:mailto:priya@example.com',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'END:VALARM',
      'END:VEVENT'
    )
    const [event] = readCalendarEvents(text, window('2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z'))
    expect(event).toMatchObject({
      uid: 'abc@google.com',
      key: 'abc@google.com',
      title: 'Design review, round 2',
      start: '2026-11-25T15:00:00.000Z',
      end: '2026-11-25T16:00:00.000Z',
      allDay: false,
      location: 'Room 4',
      description: 'Bring the\nmockups',
      organizer: { name: 'Priya Shah', email: 'priya@example.com' },
      recurring: false
    })
    expect(event.attendees).toEqual([
      { name: 'Dev, Ops', email: 'dev@example.com' },
      { name: 'Priya Shah', email: 'priya@example.com' }
    ])
  })

  it('reads UTC, floating, all-day and DURATION times', () => {
    const text = feed(
      'BEGIN:VEVENT', 'UID:utc', 'DTSTART:20261125T140000Z', 'DURATION:PT30M', 'SUMMARY:UTC', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:float', 'DTSTART:20261125T090000', 'DTEND:20261125T093000', 'SUMMARY:Floating', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:day', 'DTSTART;VALUE=DATE:20261125', 'DTEND;VALUE=DATE:20261126', 'SUMMARY:Offsite', 'END:VEVENT'
    )
    const events = readCalendarEvents(text, window('2026-11-25T00:00:00Z', '2026-11-26T05:00:00Z'))
    expect(events.map((e) => [e.title, e.start, e.end, e.allDay])).toEqual([
      ['Offsite', '2026-11-25', '2026-11-26', true],
      ['Floating', '2026-11-25T14:00:00.000Z', '2026-11-25T14:30:00.000Z', false],
      ['UTC', '2026-11-25T14:00:00.000Z', '2026-11-25T14:30:00.000Z', false]
    ])
  })

  it('maps the Windows zone names Outlook writes', () => {
    expect(resolveTimeZone('Pacific Standard Time')).toBe('America/Los_Angeles')
    expect(resolveTimeZone('Nowhere/Made_Up')).toBeNull()
    const text = feed(
      'BEGIN:VEVENT', 'UID:o', 'DTSTART;TZID=Pacific Standard Time:20261125T090000',
      'DTEND;TZID=Pacific Standard Time:20261125T100000', 'SUMMARY:Sync', 'END:VEVENT'
    )
    expect(readCalendarEvents(text, window('2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z'))[0].start)
      .toBe('2026-11-25T17:00:00.000Z')
  })

  it('keeps a weekly meeting at the same local time across a DST change', () => {
    const text = feed(
      'BEGIN:VEVENT', 'UID:standup', 'DTSTART;TZID=America/New_York:20261026T100000',
      'DTEND;TZID=America/New_York:20261026T101500', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Standup', 'END:VEVENT'
    )
    const events = readCalendarEvents(text, window('2026-10-25T00:00:00Z', '2026-11-10T00:00:00Z'))
    // EDT (UTC-4) until Nov 1, then EST (UTC-5).
    expect(events.map((e) => e.start)).toEqual([
      '2026-10-26T14:00:00.000Z',
      '2026-11-02T15:00:00.000Z',
      '2026-11-09T15:00:00.000Z'
    ])
    expect(events.every((e) => e.recurring && e.key.startsWith('standup@'))).toBe(true)
    expect(new Set(events.map((e) => e.key)).size).toBe(3)
  })

  it('applies COUNT, UNTIL, INTERVAL, EXDATE and BYDAY on several days', () => {
    const text = feed(
      'BEGIN:VEVENT', 'UID:mwf', 'DTSTART:20261102T130000Z', 'DTEND:20261102T133000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5', 'EXDATE:20261104T130000Z', 'SUMMARY:MWF', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:every2', 'DTSTART;VALUE=DATE:20261101', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261107',
      'SUMMARY:Every other day', 'END:VEVENT'
    )
    const events = readCalendarEvents(text, window('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'))
    expect(events.filter((e) => e.uid === 'mwf').map((e) => e.start.slice(0, 10))).toEqual([
      '2026-11-02', '2026-11-06', '2026-11-09', '2026-11-11'
    ])
    expect(events.filter((e) => e.uid === 'every2').map((e) => e.start)).toEqual([
      '2026-11-01', '2026-11-03', '2026-11-05', '2026-11-07'
    ])
  })

  it('reads monthly rules by weekday and by day of month', () => {
    const text = feed(
      'BEGIN:VEVENT', 'UID:lastfri', 'DTSTART:20261030T160000Z', 'DURATION:PT1H',
      'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'SUMMARY:Retro', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:15th', 'DTSTART:20261015T160000Z', 'DURATION:PT1H',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=15', 'SUMMARY:Billing', 'END:VEVENT'
    )
    const events = readCalendarEvents(text, window('2026-11-01T00:00:00Z', '2027-01-01T00:00:00Z'))
    expect(events.filter((e) => e.uid === 'lastfri').map((e) => e.start.slice(0, 10))).toEqual(['2026-11-27', '2026-12-25'])
    expect(events.filter((e) => e.uid === '15th').map((e) => e.start.slice(0, 10))).toEqual(['2026-11-15', '2026-12-15'])
  })

  it('moves and cancels single instances, and leaves out cancelled events', () => {
    const text = feed(
      'BEGIN:VEVENT', 'UID:1on1', 'DTSTART:20261102T150000Z', 'DTEND:20261102T153000Z',
      'RRULE:FREQ=WEEKLY', 'SUMMARY:1:1', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:1on1', 'RECURRENCE-ID:20261109T150000Z', 'DTSTART:20261110T170000Z',
      'DTEND:20261110T173000Z', 'SUMMARY:1:1 (moved)', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:1on1', 'RECURRENCE-ID:20261116T150000Z', 'DTSTART:20261116T150000Z',
      'STATUS:CANCELLED', 'SUMMARY:1:1', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:gone', 'DTSTART:20261103T150000Z', 'STATUS:CANCELLED', 'SUMMARY:Gone', 'END:VEVENT'
    )
    const events = readCalendarEvents(text, window('2026-11-01T00:00:00Z', '2026-11-24T00:00:00Z'))
    expect(events.map((e) => [e.title, e.start, e.key])).toEqual([
      ['1:1', '2026-11-02T15:00:00.000Z', '1on1@2026-11-02T15:00:00.000Z'],
      ['1:1 (moved)', '2026-11-10T17:00:00.000Z', '1on1@2026-11-09T15:00:00.000Z'],
      ['1:1', '2026-11-23T15:00:00.000Z', '1on1@2026-11-23T15:00:00.000Z']
    ])
  })

  it('returns only what overlaps the window, and survives junk', () => {
    const text = feed(
      'BEGIN:VEVENT', 'UID:late', 'DTSTART:20261125T233000Z', 'DTEND:20261126T003000Z', 'SUMMARY:Late', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:nostart', 'SUMMARY:No start', 'END:VEVENT',
      'not a line',
      'BEGIN:VEVENT', 'UID:bad', 'DTSTART:garbage', 'SUMMARY:Bad', 'END:VEVENT'
    )
    expect(readCalendarEvents(text, window('2026-11-26T00:00:00Z', '2026-11-27T00:00:00Z')).map((e) => e.uid)).toEqual(['late'])
    expect(readCalendarEvents('', window('2026-11-26T00:00:00Z', '2026-11-27T00:00:00Z'))).toEqual([])
  })
})

describe('meeting notes', () => {
  const event = readCalendarEvents(
    feed(
      'BEGIN:VEVENT', 'UID:abc@google.com', 'DTSTART;TZID=America/New_York:20261125T100000',
      'DTEND;TZID=America/New_York:20261125T110000', 'SUMMARY:Design review: Q1/Q2 plan', 'LOCATION:Room 4',
      'ORGANIZER;CN=Priya Shah:mailto:priya@example.com',
      'ATTENDEE;CN=Priya Shah:mailto:priya@example.com', 'ATTENDEE;CN=Dev:mailto:dev@example.com',
      'ATTENDEE:mailto:sam@example.com', 'END:VEVENT'
    ),
    window('2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z')
  )[0]

  it('names the note by local day, time and a title any file system takes', () => {
    expect(meetingNoteTitle(event, 'America/New_York')).toBe('2026-11-25 1000 Design review Q1 Q2 plan')
    expect(meetingNoteTitle(event, 'Asia/Kolkata')).toBe('2026-11-25 2030 Design review Q1 Q2 plan')
    expect(meetingDay(event, 'Asia/Tokyo')).toBe('2026-11-26')
  })

  it('writes flat frontmatter the app can read back, then the meeting facts', () => {
    const body = meetingNoteBody(event, { timeZone: 'America/New_York' })
    expect(body).toContain('type: meeting\nevent_key: abc@google.com\nevent_title: "Design review: Q1/Q2 plan"')
    expect(body).toContain('event_start: "2026-11-25T15:00:00.000Z"')
    expect(body).toContain('organizer: Priya Shah <priya@example.com>')
    expect(body).toContain('attendees:\n  - Dev <dev@example.com>\n  - sam@example.com\n---')
    expect(body).toContain('**When:** Wed, Nov 25, 10:00 AM to 11:00 AM')
    expect(body).toContain('**With:** Dev <dev@example.com>, sam@example.com')
    expect(body).toContain('## Action items')
    expect(meetingNoteKey(body)).toBe('abc@google.com')
    expect(meetingNoteKey('# Just a note\n')).toBeNull()
  })

  it('puts a template body under the meeting facts', () => {
    const body = meetingNoteBody(event, { timeZone: 'America/New_York', template: '## Decisions\n\n- ' })
    expect(body).toContain('## Decisions')
    expect(body).not.toContain('## Agenda')
  })
})
