import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CalendarFeedSummary,
  CalendarSource,
  CalendarSourcesResult
} from '@zennotes/bridge-contract/calendar'
import { Button } from './ui/Button'
import { CALENDAR_FEEDS_CHANGED_EVENT } from '../lib/calendar-meetings'
import { useStore } from '../store'

/** Whether this host can read calendars for meeting notes. */
export function calendarFeedsSettingsSupported(): boolean {
  return typeof window.zen?.calendarFeeds === 'function'
}

const FIELD =
  'w-full min-w-0 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/45'

const FEED_GROUP = 'Added by address'

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function announce(): void {
  window.dispatchEvent(new Event(CALENDAR_FEEDS_CHANGED_EVENT))
}

/** What the page says about the device's own calendars, by where access stands. */
export function deviceAccessText(result: CalendarSourcesResult): string | null {
  const device = result.device.label
  switch (result.device.access) {
    case 'not-determined':
      return `Allow ZenNotes to read this ${device}’s calendars to choose from them here. It only reads them and never changes an event.`
    case 'denied':
      return `Calendar access is off for ZenNotes. Turn on Full Access under Settings, Privacy & Security, Calendars to choose from this ${device}’s calendars.`
    case 'write-only':
      return `ZenNotes can only add events, which reads nothing. Choose Full Access under Settings, Privacy & Security, Calendars to show this ${device}’s meetings.`
    case 'restricted':
      return `Calendar access is restricted on this ${device}, for example by Screen Time, so its calendars can’t be read.`
    default:
      return null
  }
}

/** Device calendars grouped by account ("iCloud", "Gmail"), feeds last. */
export function groupCalendarSources(sources: CalendarSource[]): Array<{ title: string; sources: CalendarSource[] }> {
  const groups = new Map<string, CalendarSource[]>()
  for (const source of sources) {
    const title = source.kind === 'feed' ? FEED_GROUP : source.detail || 'On this device'
    const list = groups.get(title)
    if (list) list.push(source)
    else groups.set(title, [source])
  }
  const feeds = groups.get(FEED_GROUP)
  groups.delete(FEED_GROUP)
  const out = [...groups.entries()].map(([title, list]) => ({ title, sources: list }))
  if (feeds) out.push({ title: FEED_GROUP, sources: feeds })
  return out
}

/** The ids a vault shows after one calendar is ticked or unticked. */
export function toggledSelection(sources: CalendarSource[], id: string, on: boolean): string[] {
  return sources.filter((source) => (source.id === id ? on : source.selected)).map((source) => source.id)
}

/**
 * Settings → Calendars. Lists every calendar this vault can show: the device's
 * own calendars (on iPhone, once access is allowed) and calendars added by
 * their .ics address. Each vault ticks its own; a vault that has never been
 * changed shows them all. ZenNotes only reads calendars and never sends,
 * accepts or changes an invite. A feed's address is write-only here: the host
 * keeps it in secure storage and this page sees only the name and host.
 */
export function CalendarFeedsSettings(): JSX.Element {
  const vaultRoot = useStore((s) => s.vault?.root ?? null)
  const [feeds, setFeeds] = useState<CalendarFeedSummary[]>([])
  const [sources, setSources] = useState<CalendarSourcesResult | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    const zen = window.zen
    if (zen?.calendarSources) setSources(await zen.calendarSources())
    else if (zen?.calendarFeeds) setFeeds(await zen.calendarFeeds())
  }, [])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh, vaultRoot])

  // Coming back from the system Settings after allowing access.
  useEffect(() => {
    const again = (): void => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', again)
    window.addEventListener('focus', again)
    return () => {
      document.removeEventListener('visibilitychange', again)
      window.removeEventListener('focus', again)
    }
  }, [refresh])

  const run = async (label: string, task: () => Promise<string | null>): Promise<void> => {
    if (busy) return
    setBusy(label)
    try {
      const text = await task()
      setMessage(text ? { tone: 'ok', text } : null)
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error) })
    } finally {
      await refresh().catch(() => undefined)
      setBusy(null)
    }
  }

  const add = (): void => {
    const call = window.zen?.addCalendarFeed
    if (!call) return
    void run('Reading the calendar…', async () => {
      const feed = await call(name, address)
      setName('')
      setAddress('')
      announce()
      return `Added ${feed.name}. Its meetings show in the calendar panel’s week.`
    })
  }

  const remove = (feed: { id: string; name: string }): void => {
    const call = window.zen?.removeCalendarFeed
    if (!call) return
    void run('Removing…', async () => {
      await call(feed.id)
      announce()
      return `Removed ${feed.name} from every vault. Meeting notes you wrote stay in your vault.`
    })
  }

  const choose = (ids: string[]): void => {
    const call = window.zen?.setVaultCalendars
    if (!call) return
    void run('Saving…', async () => {
      setSources(await call(ids))
      announce()
      return null
    })
  }

  const allow = (): void => {
    const call = window.zen?.requestDeviceCalendarAccess
    if (!call) return
    void run('Waiting for your answer…', async () => {
      const next = await call()
      setSources(next)
      announce()
      return next.device.access === 'granted' ? null : deviceAccessText(next)
    })
  }

  const openSettings = (): void => {
    void window.zen?.openDeviceCalendarSettings?.()
  }

  const groups = useMemo(() => (sources ? groupCalendarSources(sources.sources) : []), [sources])
  const selectedCount = sources?.sources.filter((source) => source.selected).length ?? 0
  const accessText = sources ? deviceAccessText(sources) : null
  const access = sources?.device.access
  const canChoose = Boolean(sources?.vaultName) && typeof window.zen?.setVaultCalendars === 'function'
  const empty = sources ? sources.sources.length === 0 : feeds.length === 0

  return (
    <div data-settings-search-id="calendar-feeds" aria-busy={busy !== null} className="space-y-4 px-5 py-4">
      <div className="text-xs leading-5 text-ink-500">
        Choose the calendars whose meetings this vault shows in the calendar panel. Each vault keeps its own
        choice on this {sources?.device.label ?? 'device'}. Click a meeting to start a note with its time, place
        and guests filled in, saved under Inbox/Meetings. ZenNotes only reads your calendars and never changes
        them.
      </div>

      {sources && accessText && (
        <div className="space-y-2 rounded-xl border border-paper-300/70 px-3 py-3" data-calendar-device-access={access}>
          <div className="text-xs leading-5 text-ink-700">{accessText}</div>
          {access === 'not-determined' && window.zen?.requestDeviceCalendarAccess && (
            <Button variant="primary" disabled={busy !== null} onClick={allow}>
              Allow calendar access
            </Button>
          )}
          {(access === 'denied' || access === 'write-only') && window.zen?.openDeviceCalendarSettings && (
            <Button disabled={busy !== null} onClick={openSettings}>
              Open Settings
            </Button>
          )}
        </div>
      )}
      {sources?.device.error && (
        <div className="text-xs leading-5 text-[color:rgb(var(--z-red))]">{sources.device.error}</div>
      )}

      {sources && sources.sources.length > 0 && (
        <div className="space-y-3" data-calendar-sources>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
            <span className="min-w-0 flex-1">
              {sources.vaultName
                ? sources.customized
                  ? `${sources.vaultName} shows ${selectedCount} of ${sources.sources.length} calendars.`
                  : `${sources.vaultName} shows every calendar until you change the ticks.`
                : 'Open a vault to choose its calendars.'}
            </span>
            {canChoose && (
              <>
                <Button size="sm" variant="ghost" disabled={busy !== null}
                  onClick={() => choose(sources.sources.map((source) => source.id))}>
                  All
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => choose([])}>
                  None
                </Button>
              </>
            )}
          </div>
          {groups.map((group) => (
            <div key={group.title} className="space-y-1.5">
              <div className="text-2xs font-medium uppercase tracking-wide text-ink-400">{group.title}</div>
              {group.sources.map((source) => (
                <div key={source.id} data-calendar-source={source.id}
                  className="flex items-center gap-2 rounded-xl border border-paper-300/70 px-3 py-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={source.selected}
                      disabled={!canChoose || busy !== null}
                      onChange={(e) => choose(toggledSelection(sources.sources, source.id, e.target.checked))}
                    />
                    <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-ink-300"
                      style={source.color ? { background: source.color } : undefined} />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-800">{source.name}</span>
                  </label>
                  {source.kind === 'feed' && (
                    <>
                      <span className="truncate text-xs text-ink-400">{source.detail}</span>
                      <Button size="sm" variant="ghost"
                        onClick={() => remove({ id: source.id.slice('feed:'.length), name: source.name })}>
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2 pt-1">
        <div className="text-xs font-medium text-ink-700">Add a calendar by its .ics address</div>
        <div className="text-xs leading-5 text-ink-500">
          In Google Calendar, use the calendar’s “Secret address in iCal format”; in Outlook, publish the calendar
          and copy the ICS link. The address stays in the system’s secure storage.
          {access === 'unsupported' && sources
            ? ` This ${sources.device.label}’s own calendars aren’t read yet, so add them here by address.`
            : ''}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <label className="space-y-1 text-xs text-ink-600">
            <span>Name</span>
            <input className={FIELD} value={name} placeholder="Work" spellCheck={false}
              onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-ink-600">
            <span>.ics address</span>
            <input className={FIELD} type="password" value={address} spellCheck={false} autoComplete="off"
              data-1p-ignore="" data-lpignore="true" placeholder="https://… or webcal://…"
              onChange={(e) => setAddress(e.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={!address.trim() || busy !== null} onClick={add}>
            Add calendar
          </Button>
        </div>
      </div>

      <div role="status" aria-live="polite"
        className={`text-xs leading-5 ${message?.tone === 'error' ? 'text-[color:rgb(var(--z-red))]' : 'text-ink-700'}`}>
        {busy ?? message?.text ?? (empty ? 'No calendars yet.' : null)}
      </div>

      {!sources && feeds.length > 0 && (
        <div className="space-y-2">
          {feeds.map((feed) => (
            <div key={feed.id} className="flex items-center gap-2 rounded-xl border border-paper-300/70 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-ink-800">{feed.name}</span>
              <span className="truncate text-xs text-ink-400">{feed.host}</span>
              <Button size="sm" variant="ghost" onClick={() => remove(feed)}>Remove</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
