// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import type { VaultTask } from '@shared/tasks'
import { useStore } from '../store'
import { HomeView } from './HomeView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const focusEditorNormalMode = vi.hoisted(() => vi.fn())
vi.mock('../lib/editor-focus', () => ({ focusEditorNormalMode }))

function note(title: string, updatedAt: number): NoteMeta {
  return {
    path: `inbox/${title}.md`,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt,
    size: 0,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: ''
  }
}

describe('HomeView: opening a note hands the keyboard to the editor (#863)', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let selectNote: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    focusEditorNormalMode.mockClear()
    selectNote = vi.fn(async () => {})
    useStore.setState({
      notes: [note('Support', 2), note('Plans', 1)],
      folders: [],
      vaultTasks: [],
      tasksLoading: true,
      refreshTasks: vi.fn(async () => {}),
      selectNote,
      vaultSettings: { ...originalState.vaultSettings, favorites: ['inbox/Plans.md'] }
    })
    act(() => root.render(createElement(HomeView, { sidebarOpen: true, onShowSidebar: () => {} })))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  const click = async (selector: string): Promise<void> => {
    const row = host.querySelector<HTMLButtonElement>(selector)
    expect(row).not.toBeNull()
    await act(async () => {
      row!.click()
    })
  }

  it('from a recent note', async () => {
    await click('[data-home-section="recent"] [data-home-note-path="inbox/Support.md"]')
    expect(selectNote).toHaveBeenCalledWith('inbox/Support.md')
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('from a favorite note', async () => {
    await click('[data-home-favorite="note"][data-home-note-path="inbox/Plans.md"]')
    expect(selectNote).toHaveBeenCalledWith('inbox/Plans.md')
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('names a new note first: New note focuses its title field, like every other New note button', async () => {
    const createAndOpen = vi.fn(async () => {})
    act(() => useStore.setState({ createAndOpen }))
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New note')
    expect(button).toBeDefined()
    await act(async () => {
      button!.click()
    })
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { focusTitle: true })
  })

  it('only once the note has opened', async () => {
    let opened: () => void = () => {}
    selectNote.mockImplementation(() => new Promise<void>((resolve) => (opened = resolve)))
    await click('[data-home-section="recent"] [data-home-note-path="inbox/Support.md"]')
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
    await act(async () => opened())
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })
})

describe('HomeView: Tasks leaves empty tasks out (#1026)', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>

  function isoOffset(days: number): string {
    const now = new Date()
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  function task(id: string, content: string, due: string): VaultTask {
    return {
      id,
      sourcePath: `inbox/${id}.md`,
      noteTitle: `Note ${id}`,
      noteFolder: 'inbox',
      lineNumber: 0,
      taskIndex: 0,
      rawText: `- [ ] ${content}`.trimEnd(),
      content,
      checked: false,
      forwarded: false,
      cancelled: false,
      inProgress: false,
      waiting: false,
      tags: [],
      due
    }
  }

  // Five real tasks, one of them late, and a daily-note template's two
  // placeholders: yesterday's (now overdue) and today's.
  const TASKS = [
    task('a-late', 'Renew the passport', isoOffset(-2)),
    task('b', 'Call the bank', isoOffset(0)),
    task('c', 'Water the plants', isoOffset(0)),
    task('d', 'Book the dentist', isoOffset(0)),
    task('e', 'Send the invoice', isoOffset(0)),
    task('blank-late', '', isoOffset(-1)),
    task('blank-today', '', isoOffset(0))
  ]

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    useStore.setState({
      notes: [],
      folders: [],
      vaultTasks: TASKS,
      tasksLoading: false,
      showArchivedTasks: false,
      refreshTasks: vi.fn(async () => {})
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  const section = (): Element => host.querySelector('[data-home-section="tasks"]')!
  const rows = (): string[] =>
    [...section().querySelectorAll('li')].map((li) => li.textContent ?? '')

  it('lists only real tasks, and the overdue badge and "+N more" count only them', () => {
    useStore.setState({ hideEmptyTasks: true })
    act(() => root.render(createElement(HomeView, { sidebarOpen: true, onShowSidebar: () => {} })))
    expect(rows()).toHaveLength(5)
    expect(rows().some((text) => text.includes('- [ ]'))).toBe(false)
    expect(section().textContent).toContain('1 overdue')
    expect(section().textContent).not.toMatch(/more tasks?/)

    // Off, they show again and count again.
    act(() => useStore.setState({ hideEmptyTasks: false }))
    expect(rows()).toHaveLength(6)
    expect(section().textContent).toContain('2 overdue')
    expect(section().textContent).toContain('+1 more task')
  })

  it('says all clear when the day holds only placeholders', () => {
    useStore.setState({ hideEmptyTasks: true, vaultTasks: TASKS.filter((t) => t.content === '') })
    act(() => root.render(createElement(HomeView, { sidebarOpen: true, onShowSidebar: () => {} })))
    expect(rows()).toHaveLength(0)
    expect(section().textContent).toContain('No open tasks. All clear.')
    expect(section().textContent).not.toContain('overdue')
  })

  it('leaves out the Recent heading while there is nothing recent', () => {
    useStore.setState({ notes: [] })
    act(() => root.render(createElement(HomeView, { sidebarOpen: true, onShowSidebar: vi.fn() })))
    const section = host.querySelector('[data-home-section="recent"]')
    expect(section?.textContent).not.toContain('Recent')
    expect(section?.textContent).toContain('New note')
  })
})

describe('HomeView: the day comes first, as in the older Zotly app', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let originalZen: unknown

  function iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const todayIso = iso(new Date())

  function dayNote(): NoteMeta {
    return {
      ...note(todayIso, 5),
      path: `inbox/Daily Notes/${todayIso}.md`,
      excerpt: 'Pick up the keys. Call Sam about Friday.'
    }
  }

  beforeEach(() => {
    originalState = useStore.getState()
    originalZen = (window as { zen?: unknown }).zen
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    useStore.setState({
      notes: [note('Plans', 1)],
      folders: [],
      vaultTasks: [],
      tasksLoading: false,
      refreshTasks: vi.fn(async () => {})
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    ;(window as { zen?: unknown }).zen = originalZen
    useStore.setState(originalState, true)
  })

  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(HomeView, { sidebarOpen: true, onShowSidebar: () => {} }))
    })
  }
  const order = (): string[] =>
    [...host.querySelectorAll('[data-home-section]')].map((s) => s.getAttribute('data-home-section') ?? '')

  it("puts Today, Tasks and Meetings above Recent, and opens today's note", async () => {
    const openTodayDailyNote = vi.fn(async () => {})
    const calendarMeetings = vi.fn(async () => ({ meetings: [], failures: [] }))
    ;(window as { zen?: unknown }).zen = { ...(originalZen as object), calendarMeetings }
    useStore.setState({
      notes: [note('Plans', 1), dayNote()],
      openTodayDailyNote,
      vaultSettings: {
        ...originalState.vaultSettings,
        dailyNotes: { ...originalState.vaultSettings.dailyNotes, enabled: true }
      }
    })
    await render()
    expect(order()).toEqual(['day-note', 'tasks', 'meetings', 'recent'])
    const card = host.querySelector<HTMLButtonElement>('[data-home-kind="day-note"]')!
    expect(card.getAttribute('data-home-note-path')).toBe(`inbox/Daily Notes/${todayIso}.md`)
    expect(card.textContent).toContain('Pick up the keys.')
    await act(async () => card.click())
    expect(openTodayDailyNote).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-home-section="meetings"]')?.textContent).toContain('No meetings today.')
  })

  it('turns daily notes on before opening today, when the vault has them off', async () => {
    const calls: string[] = []
    const setVaultSettings = vi.fn(async (next: { dailyNotes: { enabled: boolean } }) => {
      calls.push(`settings:${next.dailyNotes.enabled}`)
      return true
    })
    const openTodayDailyNote = vi.fn(async () => {
      calls.push('open')
    })
    useStore.setState({
      setVaultSettings: setVaultSettings as never,
      openTodayDailyNote,
      vaultSettings: {
        ...originalState.vaultSettings,
        dailyNotes: { ...originalState.vaultSettings.dailyNotes, enabled: false }
      }
    })
    await render()
    const card = host.querySelector<HTMLButtonElement>('[data-home-kind="day-note"]')!
    expect(card.textContent).toContain("Start today's note")
    expect(card.textContent).toContain('Turns on daily notes')
    await act(async () => card.click())
    expect(calls).toEqual(['settings:true', 'open'])
  })

  it("lists today's meetings in order and opens or starts each one's note", async () => {
    const at = (h: number): string => {
      const d = new Date()
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).toISOString()
    }
    const base = {
      location: null,
      description: null,
      url: null,
      organizer: null,
      attendees: [],
      recurring: false,
      allDay: false,
      feedId: 'f',
      feedName: 'Work'
    }
    const meetings = [
      { ...base, uid: 'b', key: 'b', title: 'Design review', start: at(15), end: at(16) },
      { ...base, uid: 'a', key: 'a', title: 'Standup', start: at(9), end: at(10) }
    ]
    const calendarMeetings = vi.fn(async () => ({ meetings, failures: [] }))
    ;(window as { zen?: unknown }).zen = { ...(originalZen as object), calendarMeetings }
    const openMeetingNote = vi.fn(async () => null)
    useStore.setState({ openMeetingNote })
    await render()
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[data-home-kind="meeting"]')]
    expect(rows.map((r) => r.getAttribute('data-home-meeting'))).toEqual(['a', 'b'])
    expect(rows[0]!.textContent).toContain('Standup')
    await act(async () => rows[1]!.click())
    expect(openMeetingNote).toHaveBeenCalledWith(expect.objectContaining({ key: 'b' }))
  })

  it('leaves Meetings out where the host reads no calendars', async () => {
    ;(window as { zen?: unknown }).zen = { ...(originalZen as object), calendarMeetings: undefined }
    await render()
    expect(order()).toEqual(['day-note', 'tasks', 'recent'])
  })
})
