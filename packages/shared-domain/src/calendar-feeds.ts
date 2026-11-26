import type {
  CalendarFeedSummary,
  CalendarMeeting,
  CalendarMeetingsResult,
  CalendarSource,
  CalendarSourcesResult,
  DeviceCalendarAccess,
  DeviceCalendarInfo,
  DeviceCalendarsHost
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
  /** The device's own calendars (EventKit on iPhone). Without it, only feeds. */
  deviceCalendars?: DeviceCalendarsHost
}

/** The open vault a calendar choice belongs to. `key` is stable for the vault
 *  on this device (a fingerprint of its root), never sent anywhere. */
export interface CalendarVaultRef {
  key: string
  name: string
}

export interface CalendarFeedRecord {
  id: string
  name: string
  host: string
  addedAt: number
}

/** A vault's own choice of calendars, by source id (`feed:…`, `device:…`). */
export interface CalendarVaultChoice {
  sources: string[]
  updatedAt: number
}

export interface CalendarFeedsFile {
  version: 2
  feeds: CalendarFeedRecord[]
  /** By vault key. A vault without an entry shows no calendar until one is ticked. */
  vaults: Record<string, CalendarVaultChoice>
}

export const FEED_SOURCE_PREFIX = 'feed:'
export const DEVICE_SOURCE_PREFIX = 'device:'
const MAX_CHOSEN = 200

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

  /** Reads the feed once before keeping it, so a wrong address is caught here.
   *  A vault with its own choice of calendars gets the new one ticked, since
   *  it was added from that vault's settings; other vaults' choices stay. */
  async add(rawName: unknown, rawAddress: unknown, vault: CalendarVaultRef | null = null): Promise<CalendarFeedSummary> {
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
    await this.update((file) => {
      const vaults = { ...file.vaults }
      // A calendar added from a vault is ticked there, and only there.
      if (vault) {
        const before = vaults[vault.key]?.sources ?? []
        vaults[vault.key] = { sources: [...before, FEED_SOURCE_PREFIX + id], updatedAt: this.now() }
      }
      return { ...file, feeds: [...file.feeds, record], vaults }
    })
    return { id, name, host: record.host }
  }

  async remove(id: unknown): Promise<void> {
    if (typeof id !== 'string' || !id) return
    const source = FEED_SOURCE_PREFIX + id
    await this.update((file) => ({
      ...file,
      feeds: file.feeds.filter((feed) => feed.id !== id),
      vaults: Object.fromEntries(
        Object.entries(file.vaults).map(([key, choice]) => [
          key,
          { ...choice, sources: choice.sources.filter((entry) => entry !== source) }
        ])
      )
    }))
    this.texts.delete(id)
    await this.dependencies.secrets.delete(id)
  }

  /** Every calendar the vault can show, each marked with whether it does. */
  async sources(vault: CalendarVaultRef | null): Promise<CalendarSourcesResult> {
    const file = await this.read()
    const choice = vault ? file.vaults[vault.key] : undefined
    const chosen = choice ? new Set(choice.sources) : null
    const access = await this.deviceAccess()
    let deviceList: DeviceCalendarInfo[] = []
    let error: string | null = null
    if (access === 'granted') {
      try {
        deviceList = await this.deviceCalendarList()
      } catch (failure) {
        error = `ZenNotes could not list this ${this.device}’s calendars: ${(failure as Error).message}`
      }
    }
    const sources: CalendarSource[] = [
      ...deviceList.map((calendar) => ({
        id: DEVICE_SOURCE_PREFIX + calendar.id,
        kind: 'device' as const,
        name: calendar.name,
        detail: calendar.account,
        color: calendar.color,
        selected: false
      })),
      ...file.feeds.map((feed) => ({
        id: FEED_SOURCE_PREFIX + feed.id,
        kind: 'feed' as const,
        name: feed.name,
        detail: feed.host,
        color: null,
        selected: false
      }))
    ].map((source) => ({ ...source, selected: chosen ? chosen.has(source.id) : false }))
    return {
      vaultName: vault?.name ?? null,
      customized: Boolean(choice),
      device: { access, label: this.device, error },
      sources
    }
  }

  /** Saves the vault's own choice. Ids of calendars that are gone are dropped. */
  async choose(vault: CalendarVaultRef | null, rawIds: unknown): Promise<CalendarSourcesResult> {
    if (!vault) throw new CalendarFeedInputError('Open a vault to choose which calendars it shows.')
    if (!Array.isArray(rawIds)) throw new CalendarFeedInputError('That list of calendars is not valid.')
    const ids = [...new Set(rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 1024))]
    if (ids.length > MAX_CHOSEN) throw new CalendarFeedInputError(`Choose at most ${MAX_CHOSEN} calendars.`)
    const known = new Set((await this.sources(vault)).sources.map((source) => source.id))
    // A device calendar the host could not list just now is kept as chosen:
    // a passing failure must not wipe the person's choice.
    const kept = ids.filter((id) => known.has(id) || id.startsWith(DEVICE_SOURCE_PREFIX))
    await this.update((file) => ({
      ...file,
      vaults: { ...file.vaults, [vault.key]: { sources: kept, updatedAt: this.now() } }
    }))
    return this.sources(vault)
  }

  /** Shows the system's question for the device's calendars, once. */
  async requestDeviceAccess(vault: CalendarVaultRef | null): Promise<CalendarSourcesResult> {
    const host = this.dependencies.deviceCalendars
    if (host) {
      try {
        await host.requestAccess()
      } catch {
        // The answer below says where access stands.
      }
    }
    return this.sources(vault)
  }

  async openDeviceSettings(): Promise<void> {
    await this.dependencies.deviceCalendars?.openSettings?.()
  }

  /** Meetings overlapping the window from the calendars ticked for the vault
   *  (none while it has no choice). One calendar failing never hides the others. */
  async meetings(fromIso: unknown, toIso: unknown, vault: CalendarVaultRef | null = null): Promise<CalendarMeetingsResult> {
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
    const file = await this.read()
    const choice = vault ? file.vaults[vault.key] : undefined
    const chosen = choice ? new Set(choice.sources) : null
    const shows = (id: string): boolean => (chosen ? chosen.has(id) : false)
    const feeds = file.feeds.filter((feed) => shows(FEED_SOURCE_PREFIX + feed.id))
    await Promise.all([
      ...feeds.map(async (feed) => {
        try {
          const text = await this.feedText(feed)
          const events = readCalendarEvents(text, { from, to, defaultTimeZone: timeZone })
          for (const event of events) {
            const meeting: CalendarMeeting = { ...event, feedId: FEED_SOURCE_PREFIX + feed.id, feedName: feed.name }
            result.meetings.push(meeting)
          }
        } catch (error) {
          result.failures.push({ feedId: FEED_SOURCE_PREFIX + feed.id, feedName: feed.name, message: (error as Error).message })
        }
      }),
      this.deviceMeetings(from, to, shows, result)
    ])
    result.meetings.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)))
    return result
  }

  private async deviceMeetings(
    from: Date,
    to: Date,
    shows: (id: string) => boolean,
    result: CalendarMeetingsResult
  ): Promise<void> {
    const host = this.dependencies.deviceCalendars
    if (!host || (await this.deviceAccess()) !== 'granted') return
    const label = `Calendars on this ${this.device}`
    try {
      const calendars = (await this.deviceCalendarList()).filter((calendar) => shows(DEVICE_SOURCE_PREFIX + calendar.id))
      if (!calendars.length) return
      const names = new Map(calendars.map((calendar) => [calendar.id, calendar.name]))
      const events = await host.events({
        fromIso: from.toISOString(),
        toIso: to.toISOString(),
        calendarIds: calendars.map((calendar) => calendar.id)
      })
      for (const event of events) {
        const name = names.get(event.calendarId)
        if (name === undefined || !isDeviceEvent(event)) continue
        const { calendarId, ...rest } = event
        result.meetings.push({ ...rest, feedId: DEVICE_SOURCE_PREFIX + calendarId, feedName: name })
      }
    } catch (error) {
      result.failures.push({ feedId: DEVICE_SOURCE_PREFIX, feedName: label, message: (error as Error).message })
    }
  }

  private async deviceAccess(): Promise<DeviceCalendarAccess> {
    const host = this.dependencies.deviceCalendars
    if (!host) return 'unsupported'
    try {
      return await host.access()
    } catch {
      return 'unsupported'
    }
  }

  private async deviceCalendarList(): Promise<DeviceCalendarInfo[]> {
    const host = this.dependencies.deviceCalendars
    if (!host) return []
    const list = await host.calendars()
    return list
      .filter((calendar) => calendar && typeof calendar.id === 'string' && calendar.id && typeof calendar.name === 'string')
      .map((calendar) => ({
        id: calendar.id,
        name: calendar.name || 'Untitled calendar',
        account: typeof calendar.account === 'string' && calendar.account ? calendar.account : null,
        color: typeof calendar.color === 'string' && /^#[0-9a-f]{6}$/i.test(calendar.color) ? calendar.color : null
      }))
      .sort((a, b) => (a.account ?? '').localeCompare(b.account ?? '') || a.name.localeCompare(b.name))
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
    type Stored = { version?: unknown; feeds?: unknown; vaults?: unknown }
    let parsed: Stored | null = null
    try {
      parsed = (await this.dependencies.store.load()) as Stored | null
    } catch {
      // Damaged: no feeds.
    }
    // Version 1 had no per-vault choice, so every vault showed every feed:
    // reading it with no choices keeps that.
    if ((parsed?.version === 1 || parsed?.version === 2) && Array.isArray(parsed.feeds)) {
      this.cache = {
        version: 2,
        feeds: (parsed.feeds as CalendarFeedRecord[]).filter(
          (feed) => feed && typeof feed.id === 'string' && typeof feed.name === 'string' && typeof feed.host === 'string'
        ),
        vaults: readChoices(parsed.vaults)
      }
      return this.cache
    }
    this.cache = { version: 2, feeds: [], vaults: {} }
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

function readChoices(raw: unknown): Record<string, CalendarVaultChoice> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, CalendarVaultChoice> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const choice = value as Partial<CalendarVaultChoice> | null
    if (!key || !choice || !Array.isArray(choice.sources)) continue
    out[key] = {
      sources: choice.sources.filter((id): id is string => typeof id === 'string'),
      updatedAt: typeof choice.updatedAt === 'number' ? choice.updatedAt : 0
    }
  }
  return out
}

/** A device event as the host sent it, checked before it reaches a note. */
function isDeviceEvent(event: unknown): boolean {
  const value = event as Record<string, unknown> | null
  return Boolean(
    value &&
      typeof value.key === 'string' &&
      typeof value.uid === 'string' &&
      typeof value.title === 'string' &&
      typeof value.start === 'string' &&
      typeof value.end === 'string' &&
      typeof value.allDay === 'boolean' &&
      Array.isArray(value.attendees)
  )
}
