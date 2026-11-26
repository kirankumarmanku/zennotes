import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CalendarFeedsService, normalizeFeedAddress, type CalendarFeedSecrets } from './calendar-feeds'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261125T150000Z', 'DTEND:20261125T160000Z', 'SUMMARY:Design review', 'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n')

function secrets(): CalendarFeedSecrets & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: async (id) => values.get(id) ?? null,
    set: async (id, address) => (values.set(id, address), true),
    delete: async (id) => void values.delete(id)
  }
}

async function service(answers: Record<string, () => Response>) {
  const storageDirectory = await mkdtemp(path.join(os.tmpdir(), 'zn-cal-'))
  dirs.push(storageDirectory)
  const store = secrets()
  let clock = Date.parse('2026-11-25T12:00:00Z')
  const calls: string[] = []
  const feeds = new CalendarFeedsService({
    storageDirectory,
    secrets: store,
    timeZone: () => 'America/New_York',
    now: () => clock,
    fetch: async (url) => {
      calls.push(url)
      const answer = answers[url]
      if (!answer) throw new TypeError('offline')
      return answer()
    }
  })
  return { feeds, store, storageDirectory, calls, advance: (ms: number) => (clock += ms) }
}

const SECRET = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123/basic.ics'

describe('CalendarFeedsService', () => {
  it('keeps the address in system storage and shows only the host', async () => {
    const { feeds, store, storageDirectory } = await service({ [SECRET]: () => new Response(ICS) })
    const added = await feeds.add('Work', SECRET.replace('https://', 'webcal://'))
    expect(added).toMatchObject({ name: 'Work', host: 'calendar.google.com' })
    expect([...store.values.values()]).toEqual([SECRET])
    const file = await readFile(path.join(storageDirectory, 'feeds.json'), 'utf8')
    expect(file).not.toContain('private-abc123')
    expect(JSON.stringify(await feeds.list())).not.toContain('private-abc123')

    await feeds.remove(added.id)
    expect(await feeds.list()).toEqual([])
    expect(store.values.size).toBe(0)
  })

  it('refuses an address that is not a calendar, without keeping it', async () => {
    const { feeds, store } = await service({
      'https://example.com/page': () => new Response('<html>hi</html>'),
      'https://example.com/gone.ics': () => new Response('nope', { status: 404 })
    })
    await expect(feeds.add('Page', 'https://example.com/page')).rejects.toThrow(/did not answer with a calendar/)
    await expect(feeds.add('Gone', 'https://example.com/gone.ics')).rejects.toThrow(/refused the address/)
    await expect(feeds.add('Plain', 'http://example.com/cal.ics')).rejects.toThrow(/https/)
    expect(store.values.size).toBe(0)
    expect(() => normalizeFeedAddress('https://user:pw@example.com/a.ics')).toThrow()
  })

  it('reads meetings from the ticked feeds, caches for a few minutes and keeps the last copy offline', async () => {
    let online = true
    const { feeds, calls, advance } = await service({
      [SECRET]: () => {
        if (!online) throw new TypeError('offline')
        return new Response(ICS)
      }
    })
    const vault = { key: 'work-vault', name: 'Work' }
    await feeds.add('Work', SECRET, vault)
    // Another vault starts with nothing ticked.
    expect((await feeds.meetings('2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z')).meetings).toEqual([])
    const first = await feeds.meetings('2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z', vault)
    expect(first.meetings.map((m) => [m.title, m.feedName])).toEqual([['Design review', 'Work']])
    expect(first.failures).toEqual([])
    await feeds.meetings('2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z', vault)
    expect(calls).toHaveLength(1)

    advance(10 * 60_000)
    online = false
    const offline = await feeds.meetings('2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z', vault)
    expect(offline.meetings).toHaveLength(1)
    expect(calls).toHaveLength(2)
    await expect(feeds.meetings('2026-11-26T00:00:00Z', '2026-11-25T00:00:00Z')).rejects.toThrow(/not valid/)
  })
})
