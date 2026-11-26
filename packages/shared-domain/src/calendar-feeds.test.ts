import { describe, expect, it } from 'vitest'
import type {
  DeviceCalendarAccess,
  DeviceCalendarEvent,
  DeviceCalendarInfo,
  DeviceCalendarsHost
} from '@zennotes/bridge-contract/calendar'
import { CalendarFeedsService, type CalendarFeedsFile, type CalendarVaultRef } from './calendar-feeds'

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:standup-1',
  'DTSTART:20261126T150000Z',
  'DTEND:20261126T153000Z',
  'SUMMARY:Team standup',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n')

const FROM = '2026-11-23T00:00:00.000Z'
const TO = '2026-11-30T00:00:00.000Z'
const WORK: CalendarVaultRef = { key: 'work-key', name: 'Work' }
const HOME: CalendarVaultRef = { key: 'home-key', name: 'Home' }

function deviceEvent(calendarId: string, title: string): DeviceCalendarEvent {
  return {
    calendarId,
    uid: `${calendarId}-${title}`,
    key: `${calendarId}-${title}@2026-11-26T17:00:00.000Z`,
    title,
    start: '2026-11-26T17:00:00.000Z',
    end: '2026-11-26T18:00:00.000Z',
    allDay: false,
    location: null,
    description: null,
    url: null,
    organizer: null,
    attendees: [],
    recurring: false
  }
}

class FakeDevice implements DeviceCalendarsHost {
  state: DeviceCalendarAccess = 'not-determined'
  answer: DeviceCalendarAccess = 'granted'
  asked: string[][] = []
  failEvents = false
  list: DeviceCalendarInfo[] = [
    { id: 'cal-icloud-home', name: 'Home', account: 'iCloud', color: '#ff2968' },
    { id: 'cal-gmail-work', name: 'kiran@work', account: 'Gmail', color: '#1badf8' },
    { id: 'cal-holidays', name: 'US Holidays', account: 'Other', color: 'not a color' }
  ]
  async access(): Promise<DeviceCalendarAccess> {
    return this.state
  }
  async requestAccess(): Promise<DeviceCalendarAccess> {
    if (this.state === 'not-determined') this.state = this.answer
    return this.state
  }
  async calendars(): Promise<DeviceCalendarInfo[]> {
    return this.list
  }
  async events(options: { fromIso: string; toIso: string; calendarIds: string[] }): Promise<DeviceCalendarEvent[]> {
    if (this.failEvents) throw new Error('EventKit is not answering')
    this.asked.push(options.calendarIds)
    return options.calendarIds.map((id) => deviceEvent(id, `Meeting in ${id}`))
  }
}

function service(options: { stored?: unknown; device?: FakeDevice } = {}) {
  let stored: unknown = options.stored ?? null
  const secrets = new Map<string, string>()
  const saved: CalendarFeedsFile[] = []
  const calendars = new CalendarFeedsService({
    device: 'iPhone',
    timeZone: () => 'UTC',
    ...(options.device ? { deviceCalendars: options.device } : {}),
    store: {
      load: async () => stored,
      save: async (file) => {
        stored = JSON.parse(JSON.stringify(file))
        saved.push(file)
      }
    },
    secrets: {
      get: async (id) => secrets.get(id) ?? null,
      set: async (id, address) => {
        secrets.set(id, address)
        return true
      },
      delete: async (id) => {
        secrets.delete(id)
      }
    },
    download: async () => ({ status: 200, header: () => null, text: async () => ICS })
  })
  return { calendars, saved, secrets, stored: () => stored }
}

describe('calendars per vault', () => {
  it('shows every calendar in a vault that has no choice yet, and keeps a version 1 list', async () => {
    const { calendars, secrets } = service({
      stored: { version: 1, feeds: [{ id: 'f1', name: 'Team', host: 'calendar.example.com', addedAt: 1 }] }
    })
    secrets.set('f1', 'https://calendar.example.com/team.ics')
    const sources = await calendars.sources(WORK)
    expect(sources.customized).toBe(false)
    expect(sources.vaultName).toBe('Work')
    expect(sources.device.access).toBe('unsupported')
    expect(sources.sources).toEqual([
      { id: 'feed:f1', kind: 'feed', name: 'Team', detail: 'calendar.example.com', color: null, selected: true }
    ])
    const meetings = await calendars.meetings(FROM, TO, WORK)
    expect(meetings.meetings.map((meeting) => [meeting.title, meeting.feedId, meeting.feedName])).toEqual([
      ['Team standup', 'feed:f1', 'Team']
    ])
  })

  it('lists the device calendars only after access is allowed, and reads only the ticked ones', async () => {
    const device = new FakeDevice()
    const { calendars } = service({ device })
    expect((await calendars.sources(WORK)).sources).toEqual([])
    expect((await calendars.sources(WORK)).device.access).toBe('not-determined')
    // No question, no read.
    expect((await calendars.meetings(FROM, TO, WORK)).meetings).toEqual([])
    expect(device.asked).toEqual([])

    const allowed = await calendars.requestDeviceAccess(WORK)
    expect(allowed.device.access).toBe('granted')
    expect(allowed.sources.map((source) => [source.id, source.detail, source.color, source.selected])).toEqual([
      ['device:cal-gmail-work', 'Gmail', '#1badf8', true],
      ['device:cal-icloud-home', 'iCloud', '#ff2968', true],
      ['device:cal-holidays', 'Other', null, true]
    ])

    const chosen = await calendars.choose(WORK, ['device:cal-gmail-work'])
    expect(chosen.customized).toBe(true)
    expect(chosen.sources.filter((source) => source.selected).map((source) => source.id)).toEqual([
      'device:cal-gmail-work'
    ])
    const work = await calendars.meetings(FROM, TO, WORK)
    expect(work.meetings.map((meeting) => [meeting.title, meeting.feedId, meeting.feedName])).toEqual([
      ['Meeting in cal-gmail-work', 'device:cal-gmail-work', 'kiran@work']
    ])
    expect(work.meetings[0]).not.toHaveProperty('calendarId')
    expect(device.asked.at(-1)).toEqual(['cal-gmail-work'])

    // Another vault keeps its own choice: still every calendar.
    expect((await calendars.meetings(FROM, TO, HOME)).meetings).toHaveLength(3)
  })

  it('reads nothing for a vault whose choice is none', async () => {
    const device = new FakeDevice()
    device.state = 'granted'
    const { calendars } = service({ device })
    await calendars.choose(WORK, [])
    device.asked = []
    expect((await calendars.meetings(FROM, TO, WORK)).meetings).toEqual([])
    expect(device.asked).toEqual([])
  })

  it('ticks a new feed only in the vault it was added from, when that vault has a choice', async () => {
    const { calendars } = service()
    await calendars.choose(WORK, [])
    const added = await calendars.add('Team', 'https://calendar.example.com/team.ics', WORK)
    expect((await calendars.sources(WORK)).sources.map((source) => source.selected)).toEqual([true])
    await calendars.choose(HOME, [])
    const second = await calendars.add('Gym', 'https://gym.example.com/classes.ics', WORK)
    const home = await calendars.sources(HOME)
    expect(home.sources.map((source) => [source.id, source.selected])).toEqual([
      [`feed:${added.id}`, false],
      [`feed:${second.id}`, false]
    ])
  })

  it('takes a removed feed out of every vault’s choice', async () => {
    const { calendars, stored } = service()
    const feed = await calendars.add('Team', 'https://calendar.example.com/team.ics')
    await calendars.choose(WORK, [`feed:${feed.id}`])
    await calendars.choose(HOME, [`feed:${feed.id}`])
    await calendars.remove(feed.id)
    const file = stored() as CalendarFeedsFile
    expect(file.version).toBe(2)
    expect(file.vaults[WORK.key].sources).toEqual([])
    expect(file.vaults[HOME.key].sources).toEqual([])
  })

  it('keeps no address and no vault name in the stored list', async () => {
    const { calendars, stored } = service()
    await calendars.add('Team', 'https://calendar.example.com/private-abc123/basic.ics', WORK)
    await calendars.choose(WORK, [])
    const text = JSON.stringify(stored())
    expect(text).not.toContain('private-abc123')
    expect(text).not.toContain('"Work"')
  })

  it('drops unknown feed ids but keeps a device calendar it could not see just now', async () => {
    const device = new FakeDevice()
    device.state = 'granted'
    const { calendars, stored } = service({ device })
    await calendars.choose(WORK, ['feed:gone', 'device:cal-off-for-now', 'device:cal-icloud-home', 42])
    expect((stored() as CalendarFeedsFile).vaults[WORK.key].sources).toEqual([
      'device:cal-off-for-now',
      'device:cal-icloud-home'
    ])
  })

  it('refuses a choice with no vault open', async () => {
    const { calendars } = service()
    await expect(calendars.choose(null, [])).rejects.toThrow('Open a vault')
  })

  it('still shows feeds when the device calendars fail', async () => {
    const device = new FakeDevice()
    device.state = 'granted'
    device.failEvents = true
    const { calendars } = service({ device })
    await calendars.add('Team', 'https://calendar.example.com/team.ics')
    const result = await calendars.meetings(FROM, TO, WORK)
    expect(result.meetings.map((meeting) => meeting.title)).toEqual(['Team standup'])
    expect(result.failures).toEqual([
      { feedId: 'device:', feedName: 'Calendars on this iPhone', message: 'EventKit is not answering' }
    ])
  })

  it('says when access was refused and lists no device calendars', async () => {
    const device = new FakeDevice()
    device.answer = 'denied'
    const { calendars } = service({ device })
    const result = await calendars.requestDeviceAccess(WORK)
    expect(result.device.access).toBe('denied')
    expect(result.sources).toEqual([])
  })
})
