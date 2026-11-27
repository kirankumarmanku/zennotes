/**
 * The Calendar's day card: click a day that has a note and its note opens in
 * a card beside the panel (across the top on a phone), where it scrolls and
 * takes typing like the note itself. It replaced a read-only hover preview
 * that showed the first lines of the day and vanished when the pointer left.
 *
 * The editor is the shared inline note editor, so the day saves like any
 * note. Escape closes the card (Vim insert and visual mode and an open
 * completion menu get their Escape first); so do the close button and a
 * click outside it, which the panel handles.
 */
import { forwardRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { EditorView } from '@codemirror/view'
import { completionStatus } from '@codemirror/autocomplete'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { isEditorInsertMode, isEditorVisualMode } from '../lib/vim-nav'
import type { DayCardPlacement } from '../lib/calendar-day-card'
import { InlineNoteEditor } from './InlineNoteEditor'
import { IconButton } from './ui'
import { ArrowUpRightIcon, CloseIcon } from './icons'

export const CalendarDayCard = forwardRef<
  HTMLDivElement,
  {
    note: Pick<NoteMeta, 'path' | 'title'>
    dateLabel: string
    placement: DayCardPlacement
    onOpen: () => void
    onClose: (restoreFocus: boolean) => void
  }
>(function CalendarDayCard({ note, dateLabel, placement, onOpen, onClose }, ref) {
  const isDirty = useStore((s) => s.noteDirty[note.path] ?? false)

  const onKeyDownCapture = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Escape' || e.nativeEvent.isComposing) return
      const editorEl = (document.activeElement as HTMLElement | null)?.closest?.('.cm-editor')
      const view = editorEl ? EditorView.findFromDOM(editorEl as HTMLElement) : null
      if (view) {
        const vimMode = useStore.getState().vimMode
        if (completionStatus(view.state) === 'active') return
        if (isEditorInsertMode(view, vimMode) || isEditorVisualMode(view, vimMode)) return
      }
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    },
    [onClose]
  )

  return createPortal(
    <div
      ref={ref}
      data-calendar-day-card=""
      data-calendar-day-card-path={note.path}
      data-calendar-day-card-docked={placement.docked ? '' : undefined}
      role="dialog"
      aria-label={`Day note: ${dateLabel}`}
      className="zn-calendar-day-card fixed z-[85] flex flex-col overflow-hidden rounded-2xl bg-paper-100 shadow-float ring-1 ring-paper-300/80"
      style={{
        left: placement.left,
        width: placement.width,
        top: placement.docked
          ? `calc(env(safe-area-inset-top, 0px) + ${placement.top}px)`
          : placement.top,
        maxHeight: placement.maxHeight
      }}
      onKeyDownCapture={onKeyDownCapture}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-paper-300/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-ink-900">{dateLabel}</span>
            {isDirty && (
              <span aria-label="Unsaved changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/80" />
            )}
          </div>
          <div className="truncate text-xs text-ink-500">{note.title}</div>
        </div>
        <IconButton
          size="sm"
          title="Open in the editor"
          aria-label="Open in the editor"
          onClick={onOpen}
          data-calendar-day-card-open=""
        >
          <ArrowUpRightIcon width={14} height={14} />
        </IconButton>
        <IconButton
          size="sm"
          title="Close (Esc)"
          aria-label="Close day note"
          onClick={() => onClose(true)}
        >
          <CloseIcon width={14} height={14} />
        </IconButton>
      </header>
      <InlineNoteEditor
        key={note.path}
        path={note.path}
        label={`Note for ${dateLabel}`}
        hint="Write about this day…"
        className="min-h-[6rem] flex-1"
      />
    </div>,
    document.body
  )
})
