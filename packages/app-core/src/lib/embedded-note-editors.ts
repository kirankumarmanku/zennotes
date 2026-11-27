/**
 * Note editors that sit inside another view rather than in a pane: today's
 * note on Home, a day's note in the Calendar's day card, and the link
 * popover. The public editor API (`runEditorCommand`, attachments) targets
 * the active pane's editor, so a phone's formatting row did nothing while one
 * of these had the caret. Each registers here, so the API can find the one
 * that has the focus and the note it shows.
 */
import { EditorView, ViewPlugin } from '@codemirror/view'

const embedded = new WeakMap<EditorView, () => string>()

/** Extension that registers the view under its note path while it lives. */
export function embeddedNoteEditor(getPath: () => string) {
  return ViewPlugin.define((view) => {
    embedded.set(view, getPath)
    return {
      destroy() {
        embedded.delete(view)
      }
    }
  })
}

/** The note a registered embedded editor shows right now, or null. */
export function embeddedNoteEditorPath(view: EditorView): string | null {
  return embedded.get(view)?.() ?? null
}

/** The embedded note editor that holds the focus (its text or its own search
 *  panel), with its note's path, or null. */
export function focusedEmbeddedNoteEditor(): { view: EditorView; path: string } | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  const el = active instanceof HTMLElement ? active.closest<HTMLElement>('.cm-editor') : null
  if (!el) return null
  const view = EditorView.findFromDOM(el)
  if (!view || !view.dom.isConnected) return null
  const path = embeddedNoteEditorPath(view)
  if (!path || path.startsWith('zen://')) return null
  return { view, path }
}
