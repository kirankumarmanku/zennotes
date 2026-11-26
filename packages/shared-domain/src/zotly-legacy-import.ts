import type { S3ObjectStore } from './s3-object-store'

/**
 * Notes the older Zotly app (the Swift app in kirankumarmanku/ZotlyApp) left
 * in an S3 bucket, read so a vault that starts syncing with that bucket gets
 * them as ordinary Markdown files.
 *
 * That app always wrote under the fixed folder `zotly/`, in one of two
 * formats:
 *
 * - The change log (every build): `zotly/wal/<device>.jsonl`, one JSON entry
 *   a line. An entry names a note by UUID and carries the note's whole text
 *   on create and edit, its title, a `daily:` or `meet:` key, and a hybrid
 *   logical clock (`hlc`) that orders entries across devices.
 * - The canonical store, after a device ran the upgrade (`zotly/cutover.json`
 *   says `"scheme": "cs1"`): `zotly/cs1/notes/<uuid>.md` holds a note's text
 *   and `zotly/cs1/meta/<uuid>.json` its title, key and deletion.
 *
 * Neither is encrypted. A note that the old app hid behind Face ID (a
 * `lock:on` token in its text) is left in the bucket and counted, never
 * written into the vault, because ZenNotes has no locked notes and the vault
 * is plain files.
 *
 * Nothing here writes to the bucket.
 */

export const ZOTLY_LEGACY_PREFIX = 'zotly/'

export interface ZotlyLegacyNote {
  id: string
  title: string
  content: string
  /** Epoch milliseconds. */
  createdAt: number
  modifiedAt: number
  /** `daily:2026-11-08`, `meet:<title>|<day>`, `<calendar id>|<epoch>`, `task:<marker>` or null. */
  key: string | null
}

export interface ZotlyLegacyReadResult {
  /** Which of the old app's formats the notes came from. */
  source: 'canonical' | 'change-log' | 'none'
  notes: ZotlyLegacyNote[]
  /** Notes left out because the old app locked them. */
  locked: number
}

export interface ZotlyLegacyFile {
  /** Vault-relative path, `/` separated. */
  path: string
  content: string
  noteId: string
}

const LOCK_RE = /lock:on/i
const SWIFT_REFERENCE_EPOCH_SECONDS = 978307200

/** Whether the bucket holds anything the old app wrote. */
export async function hasZotlyLegacyNotes(store: S3ObjectStore, prefix = ZOTLY_LEGACY_PREFIX): Promise<boolean> {
  const [log, canonical] = await Promise.all([
    store.list(`${prefix}wal/`),
    store.list(`${prefix}cs1/notes/`)
  ])
  return log.some((key) => key.endsWith('.jsonl')) || canonical.some((key) => key.endsWith('.md'))
}

/** Every live, unlocked note the old app left in the bucket. */
export async function readZotlyLegacyNotes(
  store: S3ObjectStore,
  options: { prefix?: string; timeZone?: string } = {}
): Promise<ZotlyLegacyReadResult> {
  const prefix = options.prefix ?? ZOTLY_LEGACY_PREFIX
  const notes = (await usesCanonicalStore(store, prefix))
    ? await readCanonical(store, prefix, options.timeZone)
    : await readChangeLog(store, prefix, options.timeZone)
  if (!notes) return { source: 'none', notes: [], locked: 0 }
  const live = notes.notes.filter((note) => !LOCK_RE.test(note.content))
  return { source: notes.source, notes: live, locked: notes.notes.length - live.length }
}

async function usesCanonicalStore(store: S3ObjectStore, prefix: string): Promise<boolean> {
  const marker = await store.get(`${prefix}cutover.json`)
  if (!marker) return false
  const parsed = parseJson(decode(marker.body))
  return isRecord(parsed) && parsed.scheme === 'cs1'
}

// --- The canonical store ---------------------------------------------------

async function readCanonical(
  store: S3ObjectStore,
  prefix: string,
  timeZone: string | undefined
): Promise<{ source: 'canonical'; notes: ZotlyLegacyNote[] } | null> {
  const metaKeys = (await store.list(`${prefix}cs1/meta/`)).filter((key) => key.endsWith('.json'))
  const noteKeys = (await store.list(`${prefix}cs1/notes/`)).filter((key) => key.endsWith('.md'))
  if (metaKeys.length === 0 && noteKeys.length === 0) return null

  const metadata = new Map<string, Record<string, unknown>>()
  for (const key of metaKeys) {
    const found = await store.get(key)
    const parsed = found ? parseJson(decode(found.body)) : null
    if (!isRecord(parsed)) continue
    const id = typeof parsed.noteID === 'string' ? parsed.noteID : idFromKey(key, '.json')
    if (id) metadata.set(id.toLowerCase(), parsed)
  }

  const notes: ZotlyLegacyNote[] = []
  for (const key of noteKeys) {
    const id = idFromKey(key, '.md')
    if (!id) continue
    const meta = metadata.get(id)
    if (meta && stampedValue(meta.deletion) != null) continue
    const found = await store.get(key)
    if (!found) continue
    const content = decode(found.body)
    const createdSeconds = typeof meta?.createdAt === 'number' ? meta.createdAt : null
    const createdAt = createdSeconds != null ? Math.round(createdSeconds * 1000) : Date.now()
    const title = stampedString(meta?.title) ?? ''
    notes.push({
      id,
      title: title || firstLineTitle(content),
      content: renderTaskTokens(content, undefined, timeZone),
      createdAt,
      modifiedAt: createdAt,
      key: typeof meta?.key === 'string' ? meta.key : null
    })
  }
  return { source: 'canonical', notes }
}

// --- The change log --------------------------------------------------------

interface LogEntry {
  timestamp: number
  operation: string
  sectionID: string
  content?: string
  title?: string
  meetingKey?: string
  taskMeta?: Record<string, TaskMetaPatch>
  hlc?: { millis: number; counter: number }
}

interface TaskMetaPatch {
  dueChanged?: boolean
  due?: number | null
  priorityChanged?: boolean
  priority?: number
}

interface TaskMeta {
  due: number | null
  hasDue: boolean
  priority: number
  hasPriority: boolean
}

interface NoteState {
  id: string
  title: string
  content: string
  createdAt: number
  modifiedAt: number
  key: string | null
  deleted: boolean
  deletedAt: number | null
  taskMeta: Map<string, TaskMeta>
}

async function readChangeLog(
  store: S3ObjectStore,
  prefix: string,
  timeZone: string | undefined
): Promise<{ source: 'change-log'; notes: ZotlyLegacyNote[] } | null> {
  const keys = (await store.list(`${prefix}wal/`)).filter((key) => key.endsWith('.jsonl'))
  if (keys.length === 0) return null

  const entries: Array<{ entry: LogEntry; device: string; line: number }> = []
  for (const key of keys) {
    const found = await store.get(key)
    if (!found) continue
    const device = key.slice(key.lastIndexOf('/') + 1, -'.jsonl'.length)
    decode(found.body)
      .split('\n')
      .forEach((line, index) => {
        const entry = parseLogEntry(line)
        if (entry) entries.push({ entry, device, line: index })
      })
  }

  // The old app ordered every device's entries by their hybrid logical clock,
  // the device id breaking a tie. Replaying in that order and keeping the
  // newest text gives what its last merge showed, except that two edits made
  // apart and never merged keep only the later one.
  entries.sort((a, b) => {
    const [am, ac] = clock(a.entry)
    const [bm, bc] = clock(b.entry)
    if (am !== bm) return am - bm
    if (ac !== bc) return ac - bc
    if (a.device !== b.device) return a.device < b.device ? -1 : 1
    return a.line - b.line
  })

  const notes = new Map<string, NoteState>()
  const ensure = (entry: LogEntry): NoteState => {
    const id = entry.sectionID.toLowerCase()
    let note = notes.get(id)
    if (!note) {
      note = {
        id,
        title: '',
        content: '',
        createdAt: Math.round(entry.timestamp * 1000),
        modifiedAt: Math.round(entry.timestamp * 1000),
        key: null,
        deleted: false,
        deletedAt: null,
        taskMeta: new Map()
      }
      notes.set(id, note)
    }
    return note
  }

  for (const { entry } of entries) {
    const at = Math.round(entry.timestamp * 1000)
    switch (entry.operation) {
      case 'create': {
        const fresh = !notes.has(entry.sectionID.toLowerCase())
        const note = ensure(entry)
        if (fresh) {
          note.title = entry.title ?? ''
          note.content = entry.content ?? ''
          note.key = entry.meetingKey ?? null
        }
        break
      }
      case 'edit': {
        const note = ensure(entry)
        if (entry.meetingKey && (note.key == null || entry.meetingKey.startsWith('meet:'))) {
          note.key = entry.meetingKey
        }
        if (entry.taskMeta) applyTaskMeta(note, entry.taskMeta)
        if (entry.content != null) {
          note.content = entry.content
          note.modifiedAt = Math.max(note.modifiedAt, at)
          // A newer edit brings a deleted note back, as the old app did.
          if (note.deleted && note.deletedAt != null && at > note.deletedAt) {
            note.deleted = false
            note.deletedAt = null
          }
        }
        if (entry.title != null) note.title = entry.title
        break
      }
      case 'updateTitle': {
        const note = notes.get(entry.sectionID.toLowerCase())
        if (note && entry.title != null) note.title = entry.title
        break
      }
      case 'delete': {
        const note = notes.get(entry.sectionID.toLowerCase())
        if (note) {
          note.deleted = true
          note.deletedAt = at
        }
        break
      }
      case 'restore': {
        const note = notes.get(entry.sectionID.toLowerCase())
        if (note) {
          note.deleted = false
          note.deletedAt = null
        }
        break
      }
      default:
        break
    }
  }

  const live: ZotlyLegacyNote[] = []
  for (const note of notes.values()) {
    if (note.deleted) continue
    if (!note.content.trim() && !note.title.trim()) continue
    live.push({
      id: note.id,
      title: note.title || firstLineTitle(note.content),
      content: renderTaskTokens(note.content, note.taskMeta, timeZone),
      createdAt: note.createdAt,
      modifiedAt: note.modifiedAt,
      key: note.key
    })
  }
  return { source: 'change-log', notes: live }
}

function parseLogEntry(line: string): LogEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const parsed = parseJson(trimmed)
  if (!isRecord(parsed)) return null
  if (typeof parsed.timestamp !== 'number' || typeof parsed.operation !== 'string') return null
  if (typeof parsed.sectionID !== 'string') return null
  const entry: LogEntry = {
    timestamp: parsed.timestamp,
    operation: parsed.operation,
    sectionID: parsed.sectionID
  }
  if (typeof parsed.content === 'string') entry.content = parsed.content
  if (typeof parsed.title === 'string') entry.title = parsed.title
  if (typeof parsed.meetingKey === 'string') entry.meetingKey = parsed.meetingKey
  if (isRecord(parsed.taskMeta)) entry.taskMeta = parsed.taskMeta as Record<string, TaskMetaPatch>
  if (isRecord(parsed.hlc) && typeof parsed.hlc.millis === 'number') {
    entry.hlc = {
      millis: parsed.hlc.millis,
      counter: typeof parsed.hlc.counter === 'number' ? parsed.hlc.counter : 0
    }
  }
  return entry
}

function clock(entry: LogEntry): [number, number] {
  return entry.hlc ? [entry.hlc.millis, entry.hlc.counter] : [Math.round(entry.timestamp * 1000), 0]
}

function applyTaskMeta(note: NoteState, patches: Record<string, TaskMetaPatch>): void {
  for (const [marker, patch] of Object.entries(patches)) {
    if (!isRecord(patch)) continue
    const meta = note.taskMeta.get(marker) ?? { due: null, hasDue: false, priority: 99, hasPriority: false }
    if (patch.dueChanged) {
      meta.due = typeof patch.due === 'number' ? patch.due : null
      meta.hasDue = true
    }
    if (patch.priorityChanged) {
      meta.priority = typeof patch.priority === 'number' ? patch.priority : 99
      meta.hasPriority = true
    }
    note.taskMeta.set(marker, meta)
  }
}

// --- Task tokens -----------------------------------------------------------

const MARKER_RE = /\^([A-Za-z0-9]{4,})\b/
const DUE_RE = /(?:due:|📅)(\d{4}-\d{2}-\d{2})/giu
const PRIORITY_RE = /\[#([ABC])\]|!([123])\b/gi

/**
 * Later builds of the old app kept a task's due date and priority beside the
 * text, keyed by the line's `^marker`, and wrote them back into the line only
 * when it exported Markdown. Do the same, so `due:2026-07-10` and `[#A]`
 * reach the vault where ZenNotes' task scanner reads them.
 */
export function renderTaskTokens(
  content: string,
  metadata: Map<string, TaskMeta> | undefined,
  timeZone?: string
): string {
  if (!metadata || metadata.size === 0) return content
  let changed = false
  const lines = content.split('\n').map((line) => {
    const marker = MARKER_RE.exec(line)?.[1]
    const meta = marker ? metadata.get(marker) : undefined
    if (!meta) return line
    let next = line
    if (meta.hasDue) {
      next = tidy(next.replace(DUE_RE, ''))
      if (meta.due != null) next = insertToken(`due:${swiftDateDay(meta.due, timeZone)}`, next)
    }
    if (meta.hasPriority) {
      next = tidy(next.replace(PRIORITY_RE, ''))
      const token = meta.priority === 1 ? '[#A]' : meta.priority === 2 ? '[#B]' : meta.priority === 3 ? '[#C]' : null
      if (token) next = insertToken(token, next)
    }
    if (next !== line) changed = true
    return next
  })
  return changed ? lines.join('\n') : content
}

function tidy(line: string): string {
  const indent = /^\s*/.exec(line)?.[0] ?? ''
  return indent + line.slice(indent.length).replace(/ {2,}/g, ' ').trim()
}

function insertToken(token: string, line: string): string {
  const match = MARKER_RE.exec(line)
  if (match) {
    const head = line.slice(0, match.index).trimEnd()
    return `${head} ${token} ${match[0]}`
  }
  return `${line} ${token}`
}

/** A Swift `Date` as Foundation's JSON encoder writes it (seconds since 2001), as a local day. */
function swiftDateDay(seconds: number, timeZone?: string): string {
  return localDay((seconds + SWIFT_REFERENCE_EPOCH_SECONDS) * 1000, timeZone)
}

// --- Where each note goes --------------------------------------------------

/**
 * Vault paths for the notes, under `base` (`inbox` in an Inbox vault, empty
 * in a root vault):
 *
 * - a daily note (`daily:2026-11-08`) becomes `Daily Notes/2026-11-08.md`,
 *   ZenNotes' default daily-notes folder and name;
 * - a meeting note becomes `Meetings/<day> <title>.md`, which the Meetings
 *   view sorts by its day;
 * - any other note becomes `<title>.md`.
 *
 * Two notes that would share a name get the first characters of their id,
 * as the old app's own Markdown export did.
 */
export function zotlyLegacyFiles(
  notes: ZotlyLegacyNote[],
  base: string,
  options: { timeZone?: string } = {}
): ZotlyLegacyFile[] {
  const root = base.replace(/^\/+|\/+$/g, '')
  const taken = new Set<string>()
  const files: ZotlyLegacyFile[] = []
  const ordered = [...notes].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  for (const note of ordered) {
    const { folder, name } = placeFor(note, options.timeZone)
    const directory = [root, folder].filter(Boolean).join('/')
    let path = joinPath(directory, `${name}.md`)
    let length = 4
    while (taken.has(path.toLowerCase())) {
      path = joinPath(directory, `${name} ${note.id.slice(0, length)}.md`)
      length += 2
      if (length > note.id.length) {
        path = joinPath(directory, `${name} ${note.id}.md`)
        break
      }
    }
    taken.add(path.toLowerCase())
    files.push({ path, content: note.content, noteId: note.id })
  }
  return files
}

function placeFor(note: ZotlyLegacyNote, timeZone: string | undefined): { folder: string; name: string } {
  const key = note.key ?? ''
  const daily = /^daily:(\d{4}-\d{2}-\d{2})$/.exec(key)
  if (daily) return { folder: 'Daily Notes', name: daily[1]! }
  const title = cleanName(note.title) || 'Untitled'
  const meet = /^meet:.*\|(\d{4}-\d{2}-\d{2})$/.exec(key)
  if (meet) return { folder: 'Meetings', name: `${meet[1]} ${title}` }
  const occurrence = /^[^|]+\|(\d{9,})$/.exec(key)
  if (occurrence && !key.startsWith('task:')) {
    const at = Number(occurrence[1]) * 1000
    return { folder: 'Meetings', name: `${localDay(at, timeZone)} ${localTime(at, timeZone)} ${title}` }
  }
  return { folder: '', name: title }
}

function joinPath(directory: string, file: string): string {
  return directory ? `${directory}/${file}` : file
}

/** A title as a file name: no characters a file system or a wikilink refuses. */
function cleanName(title: string): string {
  return title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
    .replace(/\.+$/, '')
}

function firstLineTitle(content: string): string {
  const line = content.split('\n').find((candidate) => candidate.trim() && !LOCK_RE.test(candidate))
  if (!line) return ''
  return line.replace(/^\s*#+\s*/, '').replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '').trim().slice(0, 50)
}

// --- Small helpers ---------------------------------------------------------

function localParts(ms: number, timeZone?: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(new Date(ms))) parts[part.type] = part.value
  return parts
}

function localDay(ms: number, timeZone?: string): string {
  const parts = localParts(ms, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function localTime(ms: number, timeZone?: string): string {
  const parts = localParts(ms, timeZone)
  return `${parts.hour}${parts.minute}`
}

function idFromKey(key: string, suffix: string): string | null {
  const name = key.slice(key.lastIndexOf('/') + 1)
  if (!name.endsWith(suffix)) return null
  const id = name.slice(0, -suffix.length).toLowerCase()
  return /^[0-9a-f-]{36}$/.test(id) ? id : null
}

function stampedValue(field: unknown): unknown {
  return isRecord(field) ? field.value : undefined
}

function stampedString(field: unknown): string | null {
  const value = stampedValue(field)
  return typeof value === 'string' ? value : null
}

function decode(body: Uint8Array): string {
  return new TextDecoder().decode(body)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
