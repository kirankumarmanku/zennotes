import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'vitest'
import { installTestHost, RecordingHttp } from '../test/test-host'
import {
  addMobileCalendarFeed,
  calendarVaultKey,
  chooseMobileCalendars,
  listMobileCalendarFeeds,
  mobileCalendarSources,
  requestMobileDeviceCalendarAccess,
  mobileCalendarMeetings,
  removeMobileCalendarFeed,
  resetMobileCalendarFeeds
} from './mobile-calendar-feeds'

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

const SECRET_ADDRESS = 'webcal://calendar.example.com/private-abc123/basic.ics'

afterEach(() => resetMobileCalendarFeeds())

describe('mobile calendar feeds', () => {
  it('keeps the address in secure storage and reads meetings over native HTTP', async () => {
    const http = new RecordingHttp(() => ({ status: 200, headers: { 'Content-Type': 'text/calendar' }, data: ICS }))
    const host = installTestHost({ http, shell: { deviceWord: 'iPhone' } })
    resetMobileCalendarFeeds()

    const feed = await addMobileCalendarFeed('Work', SECRET_ADDRESS)
    assert.equal(feed.host, 'calendar.example.com')
    assert.deepEqual(await listMobileCalendarFeeds(), [feed])

    // The list holds no address; the Keychain holds it, as https.
    const list = host.storage.values.get('zennotes-calendar-feeds/feeds.json') ?? ''
    assert.equal(list.includes('private-abc123'), false)
    assert.equal(
      host.secrets.values.get(`calendar-feed:${feed.id}`),
      'https://calendar.example.com/private-abc123/basic.ics'
    )

    const result = await mobileCalendarMeetings('2026-11-26T00:00:00.000Z', '2026-11-27T00:00:00.000Z')
    assert.deepEqual(result.failures, [])
    assert.equal(result.meetings.length, 1)
    assert.equal(result.meetings[0]!.title, 'Team standup')
    assert.equal(result.meetings[0]!.feedName, 'Work')
    const request = http.requests.at(-1)!
    assert.equal(request.method, 'GET')
    assert.equal(request.url, 'https://calendar.example.com/private-abc123/basic.ics')

    // Only reads: nothing here ever writes to the calendar server.
    assert.ok(http.requests.every((sent) => sent.method === 'GET'))

    await removeMobileCalendarFeed(feed.id)
    assert.deepEqual(await listMobileCalendarFeeds(), [])
    assert.equal(host.secrets.values.size, 0)
  })

  it('reports a feed it cannot read as a failure, not a crash', async () => {
    const http = new RecordingHttp(() => ({ status: 200, headers: {}, data: ICS }))
    installTestHost({ http, shell: { deviceWord: 'iPhone' } })
    resetMobileCalendarFeeds()
    await addMobileCalendarFeed('Old', 'https://calendar.example.com/gone.ics')
    // Later the server stops answering for it; the cached copy is gone too.
    http.responder = () => ({ status: 404, headers: {}, data: 'nope' })
    resetMobileCalendarFeeds()
    const result = await mobileCalendarMeetings('2026-11-26T00:00:00.000Z', '2026-11-27T00:00:00.000Z')
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0]!.message, /Old/)
  })

  it('lists the phone’s own calendars after access and keeps each vault’s choice by a fingerprint', async () => {
    const http = new RecordingHttp(() => ({ status: 200, headers: {}, data: ICS }))
    const host = installTestHost({ http, shell: { deviceWord: 'iPhone' } })
    let access: 'not-determined' | 'granted' = 'not-determined'
    const read: string[][] = []
    host.deviceCalendars = {
      access: async () => access,
      requestAccess: async () => (access = 'granted'),
      calendars: async () => [{ id: 'ek-1', name: 'Home', account: 'iCloud', color: '#34c759' }],
      events: async ({ calendarIds }) => {
        read.push(calendarIds)
        return calendarIds.map((calendarId) => ({
          calendarId,
          uid: 'dinner',
          key: 'dinner@2026-11-26T02:00:00.000Z',
          title: 'Dinner',
          start: '2026-11-26T02:00:00.000Z',
          end: '2026-11-26T03:00:00.000Z',
          allDay: false,
          location: null,
          description: null,
          url: null,
          organizer: null,
          attendees: [],
          recurring: false
        }))
      }
    }
    resetMobileCalendarFeeds()
    const vault = { key: await calendarVaultKey('local:ZenNotes/Personal'), name: 'Personal' }
    assert.match(vault.key, /^[0-9a-f]{32}$/)
    const feed = await addMobileCalendarFeed('Work', SECRET_ADDRESS, vault)
    assert.equal((await mobileCalendarSources(vault)).device.access, 'not-determined')

    const allowed = await requestMobileDeviceCalendarAccess(vault)
    assert.deepEqual(
      allowed.sources.map((source) => source.id),
      ['device:ek-1', `feed:${feed.id}`]
    )
    await chooseMobileCalendars(vault, ['device:ek-1'])
    const result = await mobileCalendarMeetings('2026-11-25T00:00:00.000Z', '2026-11-27T00:00:00.000Z', vault)
    assert.deepEqual(result.meetings.map((meeting) => meeting.feedName), ['Home'])
    assert.deepEqual(read.at(-1), ['ek-1'])
    const list = host.storage.values.get('zennotes-calendar-feeds/feeds.json') ?? ''
    assert.equal(list.includes('Personal'), false)
    assert.ok(list.includes(vault.key))
  })
})
