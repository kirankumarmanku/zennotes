import { describe, expect, it } from 'vitest'
import { createMemoryS3ObjectStore } from './s3-object-store'
import { hasZotlyLegacyNotes, readZotlyLegacyNotes, zotlyLegacyFiles } from './zotly-legacy-import'

/**
 * Fixtures are written the way the older Zotly app's Swift JSONEncoder wrote
 * them: upper-case UUIDs, `\/` for a slash, absent keys for nil, seconds
 * since 1970 for timestamps and seconds since 2001 for a task's due date.
 */

const A = '0B1C2D3E-4F50-4A6B-8C7D-8E9FA0B1C2D3'
const B = '1A2B3C4D-5E6F-4A8B-9C0D-1E2F3A4B5C6D'
const C = '2C3D4E5F-6071-4B8C-9DAE-BFC0D1E2F304'
const D = '3D4E5F60-7182-4C9D-AEBF-C0D1E2F30415'
const E = '4E5F6071-8293-4DAE-BFC0-D1E2F3041526'

const T0 = 1_763_000_000 // 2025-11-13
const SWIFT_2001 = 978_307_200

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry).replace(/\//g, '\\/')
}

function wal(...entries: Array<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(entries.map(line).join('\n') + '\n')
}

function put(store: ReturnType<typeof createMemoryS3ObjectStore>, key: string, body: string | Uint8Array): Promise<unknown> {
  return store.put(key, typeof body === 'string' ? new TextEncoder().encode(body) : body)
}

function hlc(seconds: number, counter = 0): { millis: number; counter: number } {
  return { millis: seconds * 1000, counter }
}

describe('reading the older Zotly app’s change log', () => {
  it('replays every device’s log in clock order and keeps the newest text', async () => {
    const store = createMemoryS3ObjectStore()
    await put(
      store,
      'zotly/wal/MAC-1.jsonl',
      wal(
        { timestamp: T0, operation: 'create', sectionID: A, title: 'Groceries', content: 'milk', hlc: hlc(T0) },
        { timestamp: T0 + 10, operation: 'edit', sectionID: A, content: 'milk\neggs', hlc: hlc(T0 + 10) },
        { timestamp: T0 + 20, operation: 'create', sectionID: B, title: 'Trip/Plan', content: 'pack', hlc: hlc(T0 + 20) },
        { timestamp: T0 + 30, operation: 'delete', sectionID: B, hlc: hlc(T0 + 30) },
        { timestamp: T0 + 40, operation: 'reorder', sectionID: A, order: [A], hlc: hlc(T0 + 40) }
      )
    )
    // The phone edited A after the Mac, and renamed it.
    await put(
      store,
      'zotly/wal/PHONE-2.jsonl',
      wal(
        { timestamp: T0 + 5, operation: 'edit', sectionID: A, content: 'milk (phone)', hlc: hlc(T0 + 5) },
        { timestamp: T0 + 50, operation: 'edit', sectionID: A, content: 'milk\neggs\nbread', hlc: hlc(T0 + 50) },
        { timestamp: T0 + 60, operation: 'updateTitle', sectionID: A, title: 'Shopping', hlc: hlc(T0 + 60) }
      )
    )
    await put(store, 'zotly/wal/PHONE-2.jsonl.meta', '{"seq":3}')
    await put(store, 'zotly/meetings/PHONE-2.json', '[]')

    expect(await hasZotlyLegacyNotes(store)).toBe(true)
    const result = await readZotlyLegacyNotes(store)
    expect(result.source).toBe('change-log')
    expect(result.locked).toBe(0)
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toMatchObject({
      id: A.toLowerCase(),
      title: 'Shopping',
      content: 'milk\neggs\nbread',
      createdAt: T0 * 1000
    })
  })

  it('brings back a deleted note that a later edit touched, and honours restore', async () => {
    const store = createMemoryS3ObjectStore()
    await put(
      store,
      'zotly/wal/MAC-1.jsonl',
      wal(
        { timestamp: T0, operation: 'create', sectionID: A, title: 'One', content: 'a', hlc: hlc(T0) },
        { timestamp: T0 + 1, operation: 'delete', sectionID: A, hlc: hlc(T0 + 1) },
        { timestamp: T0 + 2, operation: 'create', sectionID: B, title: 'Two', content: 'b', hlc: hlc(T0 + 2) },
        { timestamp: T0 + 3, operation: 'delete', sectionID: B, hlc: hlc(T0 + 3) },
        { timestamp: T0 + 4, operation: 'restore', sectionID: B, hlc: hlc(T0 + 4) }
      )
    )
    await put(
      store,
      'zotly/wal/PHONE-2.jsonl',
      wal({ timestamp: T0 + 9, operation: 'edit', sectionID: A, content: 'a, edited later', hlc: hlc(T0 + 9) })
    )
    const notes = (await readZotlyLegacyNotes(store)).notes
    expect(notes.map((note) => [note.title, note.content]).sort()).toEqual([
      ['One', 'a, edited later'],
      ['Two', 'b']
    ])
  })

  it('orders entries without a clock by their timestamp, as the old app did', async () => {
    const store = createMemoryS3ObjectStore()
    await put(
      store,
      'zotly/wal/OLD.jsonl',
      wal(
        { timestamp: T0, operation: 'create', sectionID: A, title: 'Old', content: 'first' },
        { timestamp: T0 + 2, operation: 'edit', sectionID: A, content: 'third' },
        { timestamp: T0 + 1, operation: 'edit', sectionID: A, content: 'second' }
      )
    )
    expect((await readZotlyLegacyNotes(store)).notes[0]?.content).toBe('third')
  })

  it('leaves locked notes in the bucket and counts them', async () => {
    const store = createMemoryS3ObjectStore()
    await put(
      store,
      'zotly/wal/MAC-1.jsonl',
      wal(
        { timestamp: T0, operation: 'create', sectionID: A, title: 'Diary', content: 'private\nlock:on', hlc: hlc(T0) },
        { timestamp: T0, operation: 'create', sectionID: B, title: 'Open', content: 'hello', hlc: hlc(T0, 1) }
      )
    )
    const result = await readZotlyLegacyNotes(store)
    expect(result.locked).toBe(1)
    expect(result.notes.map((note) => note.title)).toEqual(['Open'])
  })

  it('writes structured due dates and priorities back into their task lines', async () => {
    const store = createMemoryS3ObjectStore()
    const due = Date.UTC(2026, 6, 10, 12) / 1000 - SWIFT_2001
    await put(
      store,
      'zotly/wal/MAC-1.jsonl',
      wal(
        {
          timestamp: T0,
          operation: 'create',
          sectionID: A,
          title: 'Tasks / ToDos',
          content: '- [ ] Call the bank #task ^ab12cd\n- [ ] Other #task ^ef34gh due:2026-01-01',
          isTaskAggregator: true,
          hlc: hlc(T0)
        },
        {
          timestamp: T0 + 1,
          operation: 'edit',
          sectionID: A,
          taskMeta: { ab12cd: { dueChanged: true, due, priorityChanged: true, priority: 1 } },
          hlc: hlc(T0 + 1)
        },
        {
          timestamp: T0 + 2,
          operation: 'edit',
          sectionID: A,
          taskMeta: { ef34gh: { dueChanged: true, priorityChanged: false, priority: 99 } },
          hlc: hlc(T0 + 2)
        }
      )
    )
    const [note] = (await readZotlyLegacyNotes(store, { timeZone: 'America/Los_Angeles' })).notes
    expect(note?.content).toBe(
      '- [ ] Call the bank #task due:2026-07-10 [#A] ^ab12cd\n- [ ] Other #task ^ef34gh'
    )
  })

  it('finds nothing in a bucket the old app never used', async () => {
    const store = createMemoryS3ObjectStore()
    await put(store, 'zotly/vaults/notes/vault.json', '{}')
    expect(await hasZotlyLegacyNotes(store)).toBe(false)
    expect(await readZotlyLegacyNotes(store)).toEqual({ source: 'none', notes: [], locked: 0 })
  })
})

describe('reading the older Zotly app’s canonical store', () => {
  function stamped(value: unknown): Record<string, unknown> {
    return { value, stamp: { hlc: hlc(T0), writerID: 'MAC-1' } }
  }

  function meta(id: string, title: string, extra: Record<string, unknown> = {}): string {
    const deletion = (extra.deleted ? { value: { at: { hlc: hlc(T0), writerID: 'MAC-1' } } } : {}) as Record<string, unknown>
    return JSON.stringify({
      schema: 1,
      noteID: id,
      title: stamped(title),
      ...(extra.key ? { key: extra.key } : {}),
      color: stamped('default'),
      flags: stamped({ isScratchPad: false, isTaskAggregator: false }),
      rank: stamped('m'),
      createdAt: T0,
      deletion: { ...deletion, stamp: { hlc: hlc(T0), writerID: 'MAC-1' } }
    })
  }

  it('reads notes and titles from cs1 once the vault was upgraded, and ignores the old log', async () => {
    const store = createMemoryS3ObjectStore()
    await put(store, 'zotly/cutover.json', JSON.stringify({ scheme: 'cs1', at: T0, by: 'MAC-1', walSequences: {} }))
    await put(store, `zotly/cs1/meta/${A.toLowerCase()}.json`, meta(A, 'Reading list'))
    await put(store, `zotly/cs1/notes/${A.toLowerCase()}.md`, '- Dune\n- Piranesi')
    await put(store, `zotly/cs1/meta/${B.toLowerCase()}.json`, meta(B, 'Gone', { deleted: true }))
    await put(store, `zotly/cs1/notes/${B.toLowerCase()}.md`, 'deleted text')
    await put(store, `zotly/cs1/meta/${C.toLowerCase()}.json`, meta(C, '', { key: 'daily:2026-11-08' }))
    await put(store, `zotly/cs1/notes/${C.toLowerCase()}.md`, 'standup at 10')
    // A body without metadata: the old app recovered it with its first line as title.
    await put(store, `zotly/cs1/notes/${D.toLowerCase()}.md`, '\n# Recovered idea\nmore')
    await put(store, 'zotly/cs1/catalog.json', '{}')
    await put(
      store,
      'zotly/wal/MAC-1.jsonl',
      wal({ timestamp: T0, operation: 'create', sectionID: E, title: 'Stale', content: 'pre-upgrade', hlc: hlc(T0) })
    )

    const result = await readZotlyLegacyNotes(store)
    expect(result.source).toBe('canonical')
    const byId = new Map(result.notes.map((note) => [note.id, note]))
    expect([...byId.keys()].sort()).toEqual([A, C, D].map((id) => id.toLowerCase()).sort())
    expect(byId.get(A.toLowerCase())).toMatchObject({ title: 'Reading list', content: '- Dune\n- Piranesi', createdAt: T0 * 1000 })
    expect(byId.get(C.toLowerCase())?.key).toBe('daily:2026-11-08')
    expect(byId.get(D.toLowerCase())?.title).toBe('Recovered idea')
  })

  it('reads the log again after a rollback removed the cutover marker', async () => {
    const store = createMemoryS3ObjectStore()
    await put(store, 'zotly/cs1/rollback-complete.json', '{}')
    await put(store, `zotly/cs1/notes/${A.toLowerCase()}.md`, 'canonical copy')
    await put(
      store,
      'zotly/wal/MAC-1.jsonl',
      wal({ timestamp: T0, operation: 'create', sectionID: A, title: 'Back', content: 'log copy', hlc: hlc(T0) })
    )
    const result = await readZotlyLegacyNotes(store)
    expect(result.source).toBe('change-log')
    expect(result.notes[0]?.content).toBe('log copy')
  })
})

describe('placing the older Zotly app’s notes in a vault', () => {
  it('puts daily, meeting and other notes where ZenNotes looks for them', () => {
    const files = zotlyLegacyFiles(
      [
        { id: 'a1b2c3d4-0000', title: 'Plan: Q1/Q2', content: 'x', createdAt: 1, modifiedAt: 1, key: null },
        { id: 'b1b2c3d4-0000', title: '2026-11-08', content: 'd', createdAt: 2, modifiedAt: 2, key: 'daily:2026-11-08' },
        { id: 'c1b2c3d4-0000', title: 'Design review', content: 'm', createdAt: 3, modifiedAt: 3, key: 'meet:design review|2026-11-25' },
        { id: 'd1b2c3d4-0000', title: 'Standup', content: 's', createdAt: 4, modifiedAt: 4, key: 'E1F2|1795622400' },
        { id: 'e1b2c3d4-0000', title: 'plan: q1/q2', content: 'y', createdAt: 5, modifiedAt: 5, key: null },
        { id: 'f1b2c3d4-0000', title: '', content: 'z', createdAt: 6, modifiedAt: 6, key: 'task:ab12cd' }
      ],
      'inbox',
      { timeZone: 'America/Los_Angeles' }
    )
    expect(files.map((file) => file.path)).toEqual([
      'inbox/Plan Q1 Q2.md',
      'inbox/Daily Notes/2026-11-08.md',
      'inbox/Meetings/2026-11-25 Design review.md',
      'inbox/Meetings/2026-11-25 0800 Standup.md',
      'inbox/plan q1 q2 e1b2.md',
      'inbox/Untitled.md'
    ])
  })

  it('uses the vault root when the vault keeps notes there', () => {
    const [file] = zotlyLegacyFiles([{ id: 'a', title: 'Idea', content: '', createdAt: 0, modifiedAt: 0, key: null }], '')
    expect(file?.path).toBe('Idea.md')
  })
})
