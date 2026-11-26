import type {
  CalendarFeedSummary,
  CalendarMeeting,
  CalendarMeetingsResult
} from '@zennotes/bridge-contract/calendar'
import { readCalendarEvents } from './calendar-ics'
import { randomUUID } from './random-uuid'

/**
 * The person's calendars, read from .ics feeds, for notes on meetings. The
 * same on every host: the desktop app keeps the list in a file and the
 * addresses in the OS keychain; the phones keep both through the portable
 * host (the address in the iOS Keychain or Android Keystore) and read feeds
 * through their native HTTP, which calendar servers' missing CORS headers
 * would otherwise block.
 *
 * Read-only by design: a feed address can only be read, so nothing here can
 * send, accept or change an invite. A feed's address is often a secret
 * (Google's "secret address in iCal format" lets anyone holding it read the
 * calendar), so it lives in secure storage. The stored list and the app only
 * ever see the feed's name and host.
 */

export interface CalendarFeedSecrets {
  get(id: string): Promise<string | null>
  set(id: string, address: string): Promise<boolean>
  delete(id: string): Promise<void>
}

/** One answer from a calendar server. `download` rejects only when no answer came. */
export interface CalendarFeedResponse {
  status: number
  header(name: string): string | null
  text(): Promise<string>
}

export interface CalendarFeedsStore {
  /** The stored list, or null when there is none yet. */
  load(): Promise<unknown>
  save(file: CalendarFeedsFile): Promise<void>
}

export interface CalendarFeedsServiceDependencies {
  store: CalendarFeedsStore
  secrets: CalendarFeedSecrets
  download(url: string, headers: Record<string, string>): Promise<CalendarFeedResponse>
  /** IANA zone for floating times. Defaults to this device's. */
  timeZone?: () => string
  now?: () => number
  /** How the host names itself in a sentence: "computer", "iPhone". */
  device?: string
}

export interface CalendarFeedRecord {
  id: string
  name: string
  host: string
  addedAt: number
}

export interface CalendarFeedsFile {
  version: 1
  feeds: CalendarFeedRecord[]
}

const CACHE_MS = 5 * 60_000
const MAX_FEED_BYTES = 15 * 1024 * 1024
const MAX_FEEDS = 20
const MAX_WINDOW_DAYS = 400

/** The headers every host sends when it reads a feed. */
export const CALENDAR_FEED_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'text/calendar, text/plain;q=0.5',
  'user-agent': 'ZenNotes'
})

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
  private cache: CalendarFeedsFile | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private readonly texts = new Map<string, { at: number; text: string }>()
  private readonly now: () => number
  private readonly device: string

  constructor(private readonly dependencies: CalendarFeedsServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.device = dependencies.device ?? 'computer'
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
      throw new CalendarFeedInputError(
        `This ${this.device} has no secure place to keep the calendar address, so it was not added.`
      )
    }
    this.texts.set(id, { at: this.now(), text })
    const record: CalendarFeedRecord = { id, name, host: url.hostname, addedAt: this.now() }
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

  private async feedText(feed: CalendarFeedRecord): Promise<string> {
    const cached = this.texts.get(feed.id)
    if (cached && this.now() - cached.at < CACHE_MS) return cached.text
    const address = await this.dependencies.secrets.get(feed.id)
    if (!address) {
      throw new CalendarFeedInputError(
        `The address is missing from this ${this.device}. Remove the calendar and add it again.`
      )
    }
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
    let response: CalendarFeedResponse
    try {
      response = await this.dependencies.download(address, { ...CALENDAR_FEED_REQUEST_HEADERS })
    } catch {
      throw new Error(`ZenNotes could not reach ${name}. Check the connection.`)
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new Error(`${name} refused the address. It may have been reset; copy it again from the calendar’s settings.`)
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`${name} answered with an error (${response.status}).`)
    const declared = Number(response.header('content-length') ?? 0)
    if (declared > MAX_FEED_BYTES) throw new Error(`${name} is too large to read.`)
    const text = await response.text()
    if (text.length > MAX_FEED_BYTES) throw new Error(`${name} is too large to read.`)
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      throw new Error(`${name} did not answer with a calendar. Use the address that ends in .ics.`)
    }
    return text
  }

  private async read(): Promise<CalendarFeedsFile> {
    if (this.cache) return this.cache
    let parsed: Partial<CalendarFeedsFile> | null = null
    try {
      parsed = (await this.dependencies.store.load()) as Partial<CalendarFeedsFile> | null
    } catch {
      // Damaged: no feeds.
    }
    if (parsed?.version === 1 && Array.isArray(parsed.feeds)) {
      this.cache = {
        version: 1,
        feeds: parsed.feeds.filter(
          (feed) => feed && typeof feed.id === 'string' && typeof feed.name === 'string' && typeof feed.host === 'string'
        )
      }
      return this.cache
    }
    this.cache = { version: 1, feeds: [] }
    return this.cache
  }

  private update(edit: (file: CalendarFeedsFile) => CalendarFeedsFile): Promise<void> {
    const run = this.writes.catch(() => undefined).then(async () => {
      const next = edit(await this.read())
      await this.dependencies.store.save(next)
      this.cache = next
    })
    this.writes = run
    return run
  }
}
