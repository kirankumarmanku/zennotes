import { useCallback, useEffect, useState } from 'react'
import type { CalendarFeedSummary } from '@zennotes/bridge-contract/calendar'
import { Button } from './ui/Button'
import { CALENDAR_FEEDS_CHANGED_EVENT } from '../lib/calendar-meetings'

/** Whether this host can read calendars for meeting notes (the desktop app). */
export function calendarFeedsSettingsSupported(): boolean {
  return typeof window.zen?.calendarFeeds === 'function'
}

const FIELD =
  'w-full min-w-0 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/45'

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function announce(): void {
  window.dispatchEvent(new Event(CALENDAR_FEEDS_CHANGED_EVENT))
}

/**
 * Settings → Calendars. Calendars are read from their .ics address, so ZenNotes
 * can show meetings and start notes on them but can never send, accept or
 * change an invite. The address is write-only here: the host keeps it in the
 * system's secure storage and this page sees only the name and host.
 */
export function CalendarFeedsSettings(): JSX.Element {
  const [feeds, setFeeds] = useState<CalendarFeedSummary[]>([])
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    const list = window.zen?.calendarFeeds
    if (list) setFeeds(await list())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (label: string, task: () => Promise<string>): Promise<void> => {
    if (busy) return
    setBusy(label)
    try {
      setMessage({ tone: 'ok', text: await task() })
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

  const remove = (feed: CalendarFeedSummary): void => {
    const call = window.zen?.removeCalendarFeed
    if (!call) return
    void run('Removing…', async () => {
      await call(feed.id)
      announce()
      return `Removed ${feed.name}. Meeting notes you wrote stay in your vault.`
    })
  }

  return (
    <div data-settings-search-id="calendar-feeds" aria-busy={busy !== null} className="space-y-4 px-5 py-4">
      <div className="text-xs leading-5 text-ink-500">
        Add a calendar by its .ics address to see your meetings in the calendar panel. Click a meeting to start a
        note with its time, place and guests filled in, saved under Inbox/Meetings. In Google Calendar, use the
        calendar’s “Secret address in iCal format”; in Outlook, publish the calendar and copy the ICS link. The
        address stays in this computer’s secure storage. ZenNotes only reads it and never changes your calendar.
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

      <div role="status" aria-live="polite"
        className={`text-xs leading-5 ${message?.tone === 'error' ? 'text-[color:rgb(var(--z-red))]' : 'text-ink-700'}`}>
        {busy ?? message?.text ?? (feeds.length ? null : 'No calendars yet.')}
      </div>

      {feeds.length > 0 && (
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
