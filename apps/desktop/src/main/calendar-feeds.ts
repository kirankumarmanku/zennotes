import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  CalendarFeedSummary,
  CalendarMeeting,
  CalendarMeetingsResult
} from '@zennotes/bridge-contract/calendar'
import { readCalendarEvents } from '@zennotes/shared-domain/calendar-ics'

/**
 * The person's calendars, read from .ics feeds, for notes on meetings.
 *
 * Read-only by design: a feed address can only be read, so nothing here can
 * send, accept or change an invite. A feed's address is often a secret
 * (Google's "secret address in iCal format" lets anyone holding it read the
 * calendar), so it lives in the system's secure storage. feeds.json and the
 * renderer only ever see the feed's name and host.
 */

export interface CalendarFeedSecrets {
  get(id: string): Promise<string | null>
  set(id: string, address: string): Promise<boolean>
  delete(id: string): Promise<void>
}

export interface CalendarFeedsDependencies {
  storageDirectory: string
  secrets: CalendarFeedSecrets
  fetch?: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>
  /** IANA zone for floating times. Defaults to this computer's. */
  timeZone?: () => string
  now?: () => number
}

interface FeedRecord {
  id: string
  name: string
  host: string
  addedAt: number
}

interface FeedsFile {
  version: 1
  feeds: FeedRecord[]
}

const CACHE_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 20_000
const MAX_FEED_BYTES = 15 * 1024 * 1024
const MAX_FEEDS = 20
const MAX_WINDOW_DAYS = 400

export class CalendarFeedInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CalendarFeedInputError'
  }
}

/** `webcal://` is how many calendars hand out a feed; it is https underneath. */
export function normalizeFeedAddress(raw: unknown): URL {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw new CalendarFeedInputError('Paste the calendar’s .ics address.')
  let url: URL
  try {
    url = new URL(text.replace(/^webcals?:\/\//i, 'https://'))
  } catch {
    throw new CalendarFeedInputError('That is not a web address. It usually starts with https:// or webcal://.')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new CalendarFeedInputError('Calendar addresses must use https.')
  }
  if (url.username || url.password) throw new CalendarFeedInputError('Use the address without a user name or password in it.')
  url.hash = ''
  return url
}

export class CalendarFeedsService {
  private cache: FeedsFile | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private readonly texts = new Map<string, { at: number; text: string }>()
  private readonly now: () => number

  constructor(private readonly dependencies: CalendarFeedsDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  async list(): Promise<CalendarFeedSummary[]> {
    return (await this.read()).feeds.map(({ id, name, host }) => ({ id, name, host }))
  }

  /** Reads the feed once before keeping it, so a wrong address is caught here. */
  async add(rawName: unknown, rawAddress: unknown): Promise<CalendarFeedSummary> {
    const url = normalizeFeedAddress(rawAddress)
    const name = (typeof rawName === 'string' ? rawName.trim() : '').slice(0, 60) || url.hostname
    const current = await this.read()
    if (current.feeds.length >= MAX_FEEDS) throw new CalendarFeedInputError(`Up to ${MAX_FEEDS} calendars can be added.`)
    const text = await this.download(url.toString(), name)
    const id = randomUUID()
    if (!(await this.dependencies.secrets.set(id, url.toString()))) {
      throw new CalendarFeedInputError('This computer has no secure place to keep the calendar address, so it was not added.')
    }
    this.texts.set(id, { at: this.now(), text })
    const record: FeedRecord = { id, name, host: url.hostname, addedAt: this.now() }
    await this.update((file) => ({ ...file, feeds: [...file.feeds, record] }))
    return { id, name, host: record.host }
  }

  async remove(id: unknown): Promise<void> {
    if (typeof id !== 'string' || !id) return
    await this.update((file) => ({ ...file, feeds: file.feeds.filter((feed) => feed.id !== id) }))
    this.texts.delete(id)
    await this.dependencies.secrets.delete(id)
  }

  /** Meetings overlapping the window from every feed. One feed failing never hides the others. */
  async meetings(fromIso: unknown, toIso: unknown): Promise<CalendarMeetingsResult> {
    const from = new Date(typeof fromIso === 'string' ? fromIso : NaN)
    const to = new Date(typeof toIso === 'string' ? toIso : NaN)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      throw new CalendarFeedInputError('That date range is not valid.')
    }
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
      throw new CalendarFeedInputError('Ask for at most a year of meetings at once.')
    }
    const timeZone = this.dependencies.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const result: CalendarMeetingsResult = { meetings: [], failures: [] }
    const feeds = (await this.read()).feeds
    await Promise.all(
      feeds.map(async (feed) => {
        try {
          const text = await this.feedText(feed)
          const events = readCalendarEvents(text, { from, to, defaultTimeZone: timeZone })
          for (const event of events) {
            const meeting: CalendarMeeting = { ...event, feedId: feed.id, feedName: feed.name }
            result.meetings.push(meeting)
          }
        } catch (error) {
          result.failures.push({ feedId: feed.id, feedName: feed.name, message: (error as Error).message })
        }
      })
    )
    result.meetings.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)))
    return result
  }

  private async feedText(feed: FeedRecord): Promise<string> {
    const cached = this.texts.get(feed.id)
    if (cached && this.now() - cached.at < CACHE_MS) return cached.text
    const address = await this.dependencies.secrets.get(feed.id)
    if (!address) throw new CalendarFeedInputError('The address is missing from this computer. Remove the calendar and add it again.')
    try {
      const text = await this.download(address, feed.name)
      this.texts.set(feed.id, { at: this.now(), text })
      return text
    } catch (error) {
      // The last copy read beats an empty panel while offline.
      if (cached) return cached.text
      throw error
    }
  }

  private async download(address: string, name: string): Promise<string> {
    const fetcher = this.dependencies.fetch ?? ((url, init) => fetch(url, { ...init, redirect: 'follow' }))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetcher(address, {
        signal: controller.signal,
        headers: { accept: 'text/calendar, text/plain;q=0.5', 'user-agent': 'ZenNotes' }
      })
    } catch {
      throw new Error(`ZenNotes could not reach ${name}. Check the connection.`)
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new Error(`${name} refused the address. It may have been reset; copy it again from the calendar’s settings.`)
    }
    if (!response.ok) throw new Error(`${name} answered with an error (${response.status}).`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_FEED_BYTES) throw new Error(`${name} is too large to read.`)
    const text = await response.text()
    if (text.length > MAX_FEED_BYTES) throw new Error(`${name} is too large to read.`)
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      throw new Error(`${name} did not answer with a calendar. Use the address that ends in .ics.`)
    }
    return text
  }

  private file(): string {
    return path.join(this.dependencies.storageDirectory, 'feeds.json')
  }

  private async read(): Promise<FeedsFile> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), 'utf8')) as FeedsFile
      if (parsed?.version === 1 && Array.isArray(parsed.feeds)) {
        this.cache = {
          version: 1,
          feeds: parsed.feeds.filter(
            (feed) => feed && typeof feed.id === 'string' && typeof feed.name === 'string' && typeof feed.host === 'string'
          )
        }
        return this.cache
      }
    } catch {
      // Missing or damaged: no feeds.
    }
    this.cache = { version: 1, feeds: [] }
    return this.cache
  }

  private update(edit: (file: FeedsFile) => FeedsFile): Promise<void> {
    const run = this.writes.catch(() => undefined).then(async () => {
      const next = edit(await this.read())
      await fs.mkdir(this.dependencies.storageDirectory, { recursive: true })
      const temporary = `${this.file()}.${process.pid}.${randomUUID()}.tmp`
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.file())
      this.cache = next
    })
    this.writes = run
    return run
  }
}
