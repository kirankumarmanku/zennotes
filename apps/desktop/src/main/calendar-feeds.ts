import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  CalendarFeedSummary,
  CalendarMeetingsResult,
  CalendarSourcesResult
} from '@zennotes/bridge-contract/calendar'
import {
  CalendarFeedsService as SharedCalendarFeedsService,
  type CalendarFeedSecrets,
  type CalendarFeedsFile,
  type CalendarVaultRef
} from '@zennotes/shared-domain/calendar-feeds'

export type { CalendarFeedSecrets, CalendarVaultRef }
export { CalendarFeedInputError, normalizeFeedAddress } from '@zennotes/shared-domain/calendar-feeds'

/**
 * The person's calendars, read from .ics feeds, for notes on meetings. The
 * rules (read-only, the address only in secure storage, caching, error
 * sentences) are shared-domain's CalendarFeedsService, which the phones use
 * too; this file gives it the desktop's storage, `<storage>/feeds.json`, and
 * Node's fetch.
 */

export interface CalendarFeedsDependencies {
  storageDirectory: string
  secrets: CalendarFeedSecrets
  fetch?: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>
  /** IANA zone for floating times. Defaults to this computer's. */
  timeZone?: () => string
  now?: () => number
}

const FETCH_TIMEOUT_MS = 20_000

export class CalendarFeedsService {
  private readonly shared: SharedCalendarFeedsService

  constructor(dependencies: CalendarFeedsDependencies) {
    const file = path.join(dependencies.storageDirectory, 'feeds.json')
    const fetcher = dependencies.fetch ?? ((url, init) => fetch(url, { ...init, redirect: 'follow' }))
    this.shared = new SharedCalendarFeedsService({
      secrets: dependencies.secrets,
      device: 'computer',
      ...(dependencies.timeZone ? { timeZone: dependencies.timeZone } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
      store: {
        async load() {
          try {
            return JSON.parse(await fs.readFile(file, 'utf8')) as unknown
          } catch {
            return null
          }
        },
        async save(next: CalendarFeedsFile) {
          await fs.mkdir(dependencies.storageDirectory, { recursive: true })
          const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
          await fs.writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
          await fs.rename(temporary, file)
        }
      },
      async download(url, headers) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
          const response = await fetcher(url, { signal: controller.signal, headers })
          return {
            status: response.status,
            header: (name) => response.headers.get(name),
            text: () => response.text()
          }
        } finally {
          clearTimeout(timer)
        }
      }
    })
  }

  list(): Promise<CalendarFeedSummary[]> {
    return this.shared.list()
  }

  add(rawName: unknown, rawAddress: unknown, vault: CalendarVaultRef | null = null): Promise<CalendarFeedSummary> {
    return this.shared.add(rawName, rawAddress, vault)
  }

  remove(id: unknown): Promise<void> {
    return this.shared.remove(id)
  }

  /** From the calendars the vault shows (all while it has no choice of its own). */
  meetings(fromIso: unknown, toIso: unknown, vault: CalendarVaultRef | null = null): Promise<CalendarMeetingsResult> {
    return this.shared.meetings(fromIso, toIso, vault)
  }

  /** The vault's calendars. The Mac's own calendars are not read yet, so
   *  these are the .ics feeds. */
  sources(vault: CalendarVaultRef | null): Promise<CalendarSourcesResult> {
    return this.shared.sources(vault)
  }

  choose(vault: CalendarVaultRef | null, ids: unknown): Promise<CalendarSourcesResult> {
    return this.shared.choose(vault, ids)
  }
}
