import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isMeetingsViewActive, useStore } from '../store'
import { ArrowUpRightIcon, CalendarIcon } from './icons'
import { CollectionViewHeader } from './CollectionViewHeader'
import { advanceSequence, getKeymapBinding, type KeymapId } from '../lib/keymaps'
import {
  listViewBindingMatches,
  listViewKey,
  listViewSequencesLive,
  listViewYieldsKey
} from '../lib/list-view-keys'
import { isAppOverlayOpen } from '../lib/overlay-open'
import { excerptBesideTitle } from '../lib/note-excerpt'
import { useMeetingNotes, type MeetingListRow } from '../lib/meetings-list'

// Every action this view answers, so a chord bound to one reaches it.
const MEETINGS_VIEW_ACTIONS: readonly KeymapId[] = [
  'nav.filter',
  'nav.moveDown',
  'nav.moveUp',
  'nav.jumpBottom',
  'nav.jumpTop',
  'nav.openResult'
]

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** "Today", "Yesterday", "Tomorrow", else "Wed, Nov 25" (with the year when not this one). */
export function meetingDayLabel(ms: number, now = new Date()): string {
  const day = new Date(ms)
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((midnight(day) - midnight(now)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === -1) return 'Yesterday'
  if (diff === 1) return 'Tomorrow'
  return day.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: day.getFullYear() === now.getFullYear() ? undefined : 'numeric'
  })
}

function timeLabel(row: MeetingListRow): string {
  if (row.time.source === 'file') return 'No meeting time'
  if (row.time.allDay) return 'All day'
  return new Date(row.time.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

export function MeetingsView(): JSX.Element {
  const selectNote = useStore((s) => s.selectNote)
  const closeActiveNote = useStore((s) => s.closeActiveNote)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const vimMode = useStore((s) => s.vimMode)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const amActive = useStore(isMeetingsViewActive)
  const { rows } = useMeetingNotes()

  const [filter, setFilter] = useState('')
  const [cursorIndex, setCursorIndex] = useState(0)
  const filterRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (row) =>
        row.title.toLowerCase().includes(q) ||
        row.note.title.toLowerCase().includes(q) ||
        row.note.excerpt.toLowerCase().includes(q)
    )
  }, [rows, filter])

  const safeCursor = Math.min(cursorIndex, Math.max(0, filtered.length - 1))
  const current = filtered[safeCursor] ?? null

  useEffect(() => {
    if (safeCursor !== cursorIndex) setCursorIndex(safeCursor)
  }, [cursorIndex, safeCursor])

  useEffect(() => {
    if (!current) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-meeting-row="${cssEscape(current.note.path)}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const openNote = useCallback(
    async (path: string) => {
      await selectNote(path)
      useStore.getState().setFocusedPanel('editor')
      requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
    },
    [selectNote]
  )

  useEffect(() => {
    if (!amActive) return
    const handler = (e: KeyboardEvent): void => {
      if (isAppOverlayOpen()) return
      const active = document.activeElement as HTMLElement | null
      if (active) {
        const tag = active.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return
      }
      const overrides = keymapOverrides
      if (listViewYieldsKey(e, overrides, MEETINGS_VIEW_ACTIONS, vimMode)) return
      const key = listViewKey(e)
      const seq = (id: KeymapId): boolean => listViewBindingMatches(e, overrides, id, vimMode)
      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      if (key === 'Escape') {
        consume()
        if (filter) setFilter('')
        else void closeActiveNote()
        return
      }
      if (seq('nav.filter')) {
        consume()
        filterRef.current?.focus()
        filterRef.current?.select()
        return
      }
      if (seq('nav.moveDown') || key === 'ArrowDown') {
        consume()
        setCursorIndex((i) => Math.max(0, Math.min(filtered.length - 1, i + 1)))
        return
      }
      if (seq('nav.moveUp') || key === 'ArrowUp') {
        consume()
        setCursorIndex((i) => Math.max(0, Math.min(filtered.length - 1, i - 1)))
        return
      }
      if (seq('nav.jumpBottom')) {
        consume()
        setCursorIndex(filtered.length - 1)
        return
      }
      if (
        listViewSequencesLive(e, vimMode) &&
        advanceSequence(
          e,
          getKeymapBinding(overrides, 'nav.jumpTop'),
          gPending,
          gTimer,
          () => setCursorIndex(0),
          consume,
          500
        )
      ) {
        return
      }
      if ((key === 'Enter' || seq('nav.openResult')) && current) {
        consume()
        void openNote(current.note.path)
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => {
      if (gTimer.current) clearTimeout(gTimer.current)
      window.removeEventListener('keydown', handler, true)
    }
  }, [amActive, closeActiveNote, current, filter, filtered.length, keymapOverrides, vimMode, openNote])

  return (
    <div
      data-preview-scroll
      data-meetings-view
      tabIndex={0}
      onMouseDownCapture={() => setFocusedPanel('editor')}
      onFocusCapture={() => setFocusedPanel('editor')}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-6">
        <CollectionViewHeader
          badge="Calendar"
          badgeIcon={<CalendarIcon width={13} height={13} />}
          title="Meetings"
          description="Your meeting notes, the latest meeting first."
          count={rows.length}
          filter={filter}
          onFilterChange={setFilter}
          filterPlaceholder="Filter meetings…"
          inputRef={filterRef}
        />

        <section
          ref={rootRef}
          className="overflow-hidden rounded-3xl border border-paper-300/70 bg-paper-50/34 shadow-[0_12px_42px_rgba(15,23,42,0.06)]"
        >
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-paper-300/70 bg-paper-100/85 text-ink-500">
                <CalendarIcon width={24} height={24} />
              </div>
              <div className="text-lg font-medium text-ink-900">
                {rows.length === 0 ? 'No meeting notes yet.' : 'No meetings match that filter.'}
              </div>
              <div className="max-w-xl text-sm leading-7 text-ink-500">
                {rows.length === 0
                  ? 'Start a note on a meeting from the calendar, and it will show up here.'
                  : 'Try a different title or a word from the note.'}
              </div>
            </div>
          ) : (
            <div className="divide-y divide-paper-300/60">
              {filtered.map((row, index) => {
                const active = index === safeCursor
                const previous = filtered[index - 1]
                const newDay =
                  row.time.source !== 'file' &&
                  (!previous || previous.time.source === 'file' || dayKey(previous.time.start) !== dayKey(row.time.start))
                return (
                  <div key={row.note.path}>
                    {newDay && (
                      <div
                        data-meeting-day
                        className="bg-paper-100/60 px-4 py-1.5 text-2xs font-medium uppercase tracking-[0.16em] text-ink-500"
                      >
                        {meetingDayLabel(row.time.start)}
                      </div>
                    )}
                    <div
                      role="button"
                      tabIndex={-1}
                      data-meeting-row={row.note.path}
                      onMouseMove={() => setCursorIndex(index)}
                      onClick={() => void openNote(row.note.path)}
                      className={[
                        'group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                        active ? 'bg-paper-200/80' : 'hover:bg-paper-100/80'
                      ].join(' ')}
                    >
                      <div className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-ink-500">{timeLabel(row)}</div>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <div className="truncate text-sm font-medium text-ink-900">{row.title}</div>
                        <div className="mt-1 line-clamp-1 text-sm leading-5 text-ink-600">
                          {excerptBesideTitle(row.title, row.note.excerpt) || 'Empty note'}
                        </div>
                      </div>
                      <div className="zn-hover-reveal flex shrink-0 items-center gap-1.5 self-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void openNote(row.note.path)
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-paper-100/85 px-2.5 py-1 text-xs font-medium text-ink-700 transition-colors hover:bg-paper-200 hover:text-ink-900"
                        >
                          <ArrowUpRightIcon width={13} height={13} />
                          Open
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
