import type {
  CalendarFeedSummary,
  CalendarMeetingsResult,
  CalendarSourcesResult
} from '@zennotes/bridge-contract/calendar'
import {
  CalendarFeedsService,
  type CalendarFeedsFile,
  type CalendarVaultRef
} from '@zennotes/shared-domain/calendar-feeds'
import { portableHost } from './host'

/**
 * Calendar feeds on a phone, for notes on meetings: the rules are
 * shared-domain's CalendarFeedsService, the same object the desktop app
 * runs. The list (names and hosts only) lives in the host's durable storage;
 * each feed's address, often a secret one, lives in SecretStorage (the iOS
 * Keychain, Android's Keystore). Feeds are read with the host's native HTTP,
 * because calendar servers send no CORS headers a WebView would accept.
 *
 * The phone's own calendars come from the host's deviceCalendars (EventKit
 * on iPhone), once the person allows access. Each vault keeps its own choice
 * of calendars on this device, by a fingerprint of the vault.
 *
 * Read-only: a feed can only be read, and the device calendars are only
 * listed and read, so nothing here sends, accepts or changes an invite.
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
  const deviceCalendars = portableHost().deviceCalendars
  service = new CalendarFeedsService({
    device: portableHost().shell.deviceWord ?? 'device',
    ...(deviceCalendars ? { deviceCalendars } : {}),
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

export type { CalendarVaultRef }

export function listMobileCalendarFeeds(): Promise<CalendarFeedSummary[]> {
  return feeds().list()
}

export function addMobileCalendarFeed(
  name: string,
  address: string,
  vault: CalendarVaultRef | null = null
): Promise<CalendarFeedSummary> {
  return feeds().add(name, address, vault)
}

export function removeMobileCalendarFeed(id: string): Promise<void> {
  return feeds().remove(id)
}

export function mobileCalendarMeetings(
  fromIso: string,
  toIso: string,
  vault: CalendarVaultRef | null = null
): Promise<CalendarMeetingsResult> {
  return feeds().meetings(fromIso, toIso, vault)
}

export function mobileCalendarSources(vault: CalendarVaultRef | null): Promise<CalendarSourcesResult> {
  return feeds().sources(vault)
}

export function chooseMobileCalendars(vault: CalendarVaultRef | null, ids: unknown): Promise<CalendarSourcesResult> {
  return feeds().choose(vault, ids)
}

export function requestMobileDeviceCalendarAccess(vault: CalendarVaultRef | null): Promise<CalendarSourcesResult> {
  return feeds().requestDeviceAccess(vault)
}

export function openMobileDeviceCalendarSettings(): Promise<void> {
  return feeds().openDeviceSettings()
}

/** The key a vault's calendar choice is kept under: a fingerprint, so the
 *  stored list never names the vault's folder. */
export async function calendarVaultKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
