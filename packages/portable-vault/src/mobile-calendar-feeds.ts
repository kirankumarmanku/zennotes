import type { CalendarFeedSummary, CalendarMeetingsResult } from '@zennotes/bridge-contract/calendar'
import { CalendarFeedsService, type CalendarFeedsFile } from '@zennotes/shared-domain/calendar-feeds'
import { portableHost } from './host'

/**
 * Calendar feeds on a phone, for notes on meetings: the rules are
 * shared-domain's CalendarFeedsService, the same object the desktop app
 * runs. The list (names and hosts only) lives in the host's durable storage;
 * each feed's address, often a secret one, lives in SecretStorage (the iOS
 * Keychain, Android's Keystore). Feeds are read with the host's native HTTP,
 * because calendar servers send no CORS headers a WebView would accept.
 *
 * Read-only: a feed can only be read, so nothing here sends, accepts or
 * changes an invite.
 */

const LIST_PATH = 'zennotes-calendar-feeds/feeds.json'
const SECRET_PREFIX = 'calendar-feed:'
const READ_TIMEOUT_MS = 20_000

let service: CalendarFeedsService | null = null

/** For tests: start from a fresh service (and cache). */
export function resetMobileCalendarFeeds(): void {
  service = null
}

function feeds(): CalendarFeedsService {
  if (service) return service
  service = new CalendarFeedsService({
    device: portableHost().shell.deviceWord ?? 'device',
    store: {
      async load() {
        const raw = await portableHost().storage.read(LIST_PATH)
        return raw === null ? null : (JSON.parse(raw) as unknown)
      },
      async save(file: CalendarFeedsFile) {
        await portableHost().storage.write(LIST_PATH, JSON.stringify(file))
      }
    },
    secrets: {
      async get(id) {
        const secrets = portableHost().secrets
        if (!secrets.available()) return null
        await secrets.prepare?.()
        return secrets.get(SECRET_PREFIX + id)
      },
      async set(id, address) {
        const secrets = portableHost().secrets
        if (!secrets.available()) return false
        await secrets.prepare?.()
        await secrets.set(SECRET_PREFIX + id, address)
        return true
      },
      async delete(id) {
        const secrets = portableHost().secrets
        if (!secrets.available()) return
        await secrets.prepare?.()
        await secrets.remove(SECRET_PREFIX + id)
      }
    },
    async download(url, headers) {
      const response = await portableHost().http.request({
        url,
        method: 'GET',
        headers,
        responseType: 'text',
        connectTimeout: READ_TIMEOUT_MS,
        readTimeout: READ_TIMEOUT_MS
      })
      const lower = Object.fromEntries(
        Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])
      )
      return {
        status: response.status,
        header: (name) => lower[name.toLowerCase()] ?? null,
        text: async () =>
          typeof response.data === 'string'
            ? response.data
            : response.data === null || response.data === undefined
              ? ''
              : JSON.stringify(response.data)
      }
    }
  })
  return service
}

export function listMobileCalendarFeeds(): Promise<CalendarFeedSummary[]> {
  return feeds().list()
}

export function addMobileCalendarFeed(name: string, address: string): Promise<CalendarFeedSummary> {
  return feeds().add(name, address)
}

export function removeMobileCalendarFeed(id: string): Promise<void> {
  return feeds().remove(id)
}

export function mobileCalendarMeetings(fromIso: string, toIso: string): Promise<CalendarMeetingsResult> {
  return feeds().meetings(fromIso, toIso)
}
