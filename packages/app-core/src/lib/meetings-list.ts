import { useEffect, useMemo, useState } from 'react'
import type { NoteMeta } from '@shared/ipc'
import { DEFAULT_MEETING_NOTES_FOLDER } from '@shared/meeting-notes'
import {
  meetingFrontmatter,
  meetingNoteTime,
  sortMeetingsLatestFirst,
  type MeetingTime
} from '@shared/meetings-view'
import { noteFolderSubpath, normalizeVaultSettings } from './vault-layout'
import { useStore } from '../store'

export interface MeetingListRow {
  note: NoteMeta
  time: MeetingTime
  /** The meeting's own title from the note, else the note's name. */
  title: string
}

/** A note `openMeetingNote` makes lives in Inbox/Meetings (or a folder inside it). */
export function isMeetingNote(
  note: Pick<NoteMeta, 'folder' | 'path'>,
  settings: Parameters<typeof noteFolderSubpath>[1]
): boolean {
  if (note.folder !== 'inbox') return false
  const subpath = noteFolderSubpath(note, settings)
  return subpath === DEFAULT_MEETING_NOTES_FOLDER || subpath.startsWith(`${DEFAULT_MEETING_NOTES_FOLDER}/`)
}

/** `2026-11-25 1500 Design review` without its date and time. */
function titleWithoutTime(title: string): string {
  return title.replace(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:?\d{2})?\s+/, '').trim() || title
}

interface NoteFacts {
  updatedAt: number
  eventStart: string | null
  eventTitle: string | null
}

/** Frontmatter read from disk, per vault and note, kept until the note changes. */
const factsCache = new Map<string, NoteFacts>()

function cacheKey(vaultRoot: string, path: string): string {
  return `${vaultRoot}\u0000${path}`
}

export function factsFromBody(body: string): Omit<NoteFacts, 'updatedAt'> {
  const front = meetingFrontmatter(body)
  return { eventStart: front?.start ?? null, eventTitle: front?.title ?? null }
}

/** Rows for notes, in order, given what is known of each note's frontmatter. */
export function buildMeetingRows(
  notes: readonly NoteMeta[],
  factsFor: (note: NoteMeta) => Omit<NoteFacts, 'updatedAt'> | null
): MeetingListRow[] {
  return sortMeetingsLatestFirst(
    notes.map((note) => {
      const facts = factsFor(note)
      return {
        note,
        time: meetingNoteTime(note, facts?.eventStart ?? null),
        title: facts?.eventTitle ?? titleWithoutTime(note.title)
      }
    })
  )
}

/**
 * The vault's meeting notes, latest meeting first. Rows show at once, timed by
 * their names, and move to their frontmatter's `event_start` as each note is
 * read. An open note's unsaved text counts.
 */
export function useMeetingNotes(): { rows: MeetingListRow[]; loading: boolean } {
  const notes = useStore((s) => s.notes)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const vaultRoot = useStore((s) => s.vault?.root ?? '')
  const noteContents = useStore((s) => s.noteContents)
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(false)

  const meetingNotes = useMemo(() => {
    const settings = normalizeVaultSettings(vaultSettings)
    return notes.filter((note) => isMeetingNote(note, settings))
  }, [notes, vaultSettings])

  useEffect(() => {
    const missing = meetingNotes.filter((note) => {
      const cached = factsCache.get(cacheKey(vaultRoot, note.path))
      return !cached || cached.updatedAt !== note.updatedAt
    })
    if (missing.length === 0) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      for (let i = 0; i < missing.length && !cancelled; i += 8) {
        await Promise.all(
          missing.slice(i, i + 8).map(async (note) => {
            try {
              const { body } = await window.zen.readNote(note.path)
              factsCache.set(cacheKey(vaultRoot, note.path), { updatedAt: note.updatedAt, ...factsFromBody(body) })
            } catch {
              // Unreadable now (moved, offline remote): its name still times it.
              factsCache.set(cacheKey(vaultRoot, note.path), {
                updatedAt: note.updatedAt,
                eventStart: null,
                eventTitle: null
              })
            }
          })
        )
        if (!cancelled) setVersion((v) => v + 1)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [meetingNotes, vaultRoot])

  const rows = useMemo(
    () =>
      buildMeetingRows(meetingNotes, (note) => {
        const open = noteContents[note.path]
        if (open) return factsFromBody(open.body)
        return factsCache.get(cacheKey(vaultRoot, note.path)) ?? null
      }),
    // `version` re-sorts once more notes have been read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meetingNotes, noteContents, vaultRoot, version]
  )

  return { rows, loading }
}
