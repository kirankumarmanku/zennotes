/**
 * A note's own editor, sitting inside another view rather than in a pane:
 * today's note on Home, and a day's note in the Calendar's day card. Type and
 * it saves like any note, as the older Zotly app's day did.
 *
 * It edits the store's path-keyed `noteContents`, the buffer every pane, the
 * pinned reference pane and the link popover share, so an edit here shows up
 * in an open tab of the same note and saves through the same debounced path.
 * `holdInlineNote` reads the note into that buffer and keeps it alive while
 * the editor shows it; `releaseInlineNote` saves the last edit as it goes.
 *
 * Keys: the wrapper is a self-keyed surface (see `SELF_KEYED_SURFACES`), so
 * VimNav and the views around it leave every key to the editor.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { Annotation, type AnnotationType, EditorSelection, EditorState, type Extension, type Transaction } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, placeholder, tooltips } from '@codemirror/view'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { history } from '@codemirror/commands'
import { autocompletion } from '@codemirror/autocomplete'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { useStore } from '../store'
import { noteEditingLockExtension, noteEditingSync, refreshNoteEditingLock } from '../lib/note-lifecycle-lock'
import { scrollerClickFocus } from '../lib/cm-scroller-click-focus'
import { vimAwareMarkdownKeymap } from '../lib/cm-vim-default-keymap'
import { isTouchPrimaryDevice, vimImeGuard } from '../lib/cm-vim-ime-guard'
import { vimVisualHighlightExtension } from '../lib/cm-vim-visual-highlight'
import { noteMarkdown } from '../lib/cm-markdown-language'
import { customCodeFenceHighlightExtension } from '../lib/cm-custom-code-languages'
import { markdownLinkExtension } from '../lib/cm-markdown-links'
import { listIndentWidth, markdownListIndentPlugin } from '../lib/cm-markdown-list-indent'
import { livePreviewPlugin } from '../lib/cm-live-preview'
import { sourceRevealExtension } from '../lib/cm-source-reveal'
import { frontmatterStyle, frontmatterTagExtension } from '../lib/cm-frontmatter'
import { slashCommandRender, slashCommandSource } from '../lib/cm-slash-commands'
import { calloutTypeSource } from '../lib/cm-callouts'
import { dateShortcutSource } from '../lib/cm-date-shortcuts'
import { wikilinkBlockSource, wikilinkHeadingSource, wikilinkSource } from '../lib/cm-wikilinks'
import { hashtagSource } from '../lib/cm-hashtag-complete'
import { frontmatterTagSource } from '../lib/cm-frontmatter-tag-complete'
import { completionKeymapExtension, completionNavKeymap } from '../lib/cm-completion-nav'
import { editorTabSize } from '../lib/editor-tab-size'
import { appMarkdownSnippetExtension } from '../lib/markdown-snippets-config'
import { cursorDrawSelection } from '../lib/cm-cursor-blink'
import { getKeymapBinding } from '../lib/keymaps'
import { keyBindingsFor } from '../lib/vim-half-page-keymap'
import { openLinkPopoverAtCursor } from '../lib/link-popover-open'
import { buildReferenceKeymap, paperHighlight } from './PinnedReferencePane'

type KeymapOverrides = ReturnType<typeof useStore.getState>['keymapOverrides']

/**
 * The editor the link popover and the inline editors share: the pinned
 * reference pane's building blocks without its gutters, writing every edit
 * not marked `programmatic` back to the store under `getPath()`.
 */
export function buildEmbeddedNoteExtensions({
  getPath,
  programmatic,
  keymapOverrides,
  extra = []
}: {
  getPath: () => string
  programmatic: AnnotationType<boolean>
  keymapOverrides: KeymapOverrides
  extra?: Extension[]
}): Extension[] {
  const s0 = useStore.getState()
  return [
    noteEditingLockExtension(() => ({ vault: useStore.getState().vault, path: getPath() })),
    appMarkdownSnippetExtension(),
    sourceRevealExtension,
    s0.vimMode ? vim() : [],
    vimImeGuard(() => useStore.getState().vimBlockImeInNormalMode && !isTouchPrimaryDevice()),
    vimVisualHighlightExtension,
    history(),
    scrollerClickFocus,
    cursorDrawSelection(s0.cursorBlink),
    editorTabSize(s0.editorTabSize),
    listIndentWidth(s0.editorTabSize),
    highlightActiveLine(),
    EditorView.lineWrapping,
    noteMarkdown(),
    customCodeFenceHighlightExtension,
    markdownLinkExtension,
    vimAwareMarkdownKeymap,
    markdownListIndentPlugin,
    frontmatterStyle,
    frontmatterTagExtension,
    syntaxHighlighting(paperHighlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    s0.livePreview ? livePreviewPlugin : [],
    tooltips({ parent: document.body }),
    autocompletion({
      defaultKeymap: false,
      override: [
        slashCommandSource,
        calloutTypeSource,
        dateShortcutSource,
        frontmatterTagSource,
        hashtagSource,
        wikilinkSource,
        wikilinkHeadingSource,
        wikilinkBlockSource
      ],
      addToOptions: [{ render: slashCommandRender.render, position: 0 }],
      icons: false,
      optionClass: (completion) => {
        const kind = (completion as { _kind?: string })._kind
        if (kind === 'wikilink') return 'wikilink-cmd-option'
        if (kind === 'callout') return 'callout-cmd-option'
        return 'slash-cmd-option'
      }
    }),
    completionNavKeymap,
    completionKeymapExtension,
    keymap.of([
      // A link's note opens in the link popover, over whatever holds this
      // editor, so it can be read and written without leaving.
      ...keyBindingsFor(getKeymapBinding(keymapOverrides, 'editor.linkPopover'), (view) =>
        openLinkPopoverAtCursor(view)
      )
    ]),
    buildReferenceKeymap(s0.vimMode, keymapOverrides),
    ...extra,
    EditorView.updateListener.of((upd) => {
      if (!upd.docChanged) return
      if (upd.transactions.some((tr: Transaction) => tr.annotation(programmatic))) return
      useStore.getState().updateNoteBody(getPath(), upd.state.doc.toString())
    })
  ]
}

const programmatic = Annotation.define<boolean>()

/** Mirror edits made elsewhere (an open tab of the same note, a sync) into
 *  `view`, keeping its cursor where it was. */
export function syncEmbeddedNoteBody(
  view: EditorView,
  next: string,
  annotation: AnnotationType<boolean>
): void {
  if (view.state.doc.toString() === next) return
  const sel = view.state.selection.main
  refreshNoteEditingLock(view)
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    annotations: [annotation.of(true), noteEditingSync.of(true)],
    selection: {
      anchor: Math.min(sel.anchor, next.length),
      head: Math.min(sel.head, next.length)
    }
  })
}

export function InlineNoteEditor({
  path,
  focus = false,
  hint = 'Write here…',
  label,
  className = ''
}: {
  path: string
  /** Take the keyboard as it shows, cursor at the note's end: the note was
   *  just started from the card. Read on mount. */
  focus?: boolean
  /** Shown while the note has no text. */
  hint?: string
  label: string
  className?: string
}): JSX.Element {
  const holdInlineNote = useStore((s) => s.holdInlineNote)
  const releaseInlineNote = useStore((s) => s.releaseInlineNote)
  const loaded = useStore((s) => !!s.noteContents[path])

  useEffect(() => {
    void holdInlineNote(path)
    return () => releaseInlineNote(path)
  }, [path, holdInlineNote, releaseInlineNote])

  return (
    <div
      data-inline-note-editor=""
      data-inline-note-path={path}
      role="group"
      aria-label={label}
      className={`zn-inline-note ${className}`}
    >
      {loaded ? (
        <InlineNoteView key={path} path={path} focus={focus} hint={hint} />
      ) : (
        <div className="px-3 py-2 text-sm text-ink-400">Loading…</div>
      )}
    </div>
  )
}

function InlineNoteView({
  path,
  focus,
  hint
}: {
  path: string
  focus: boolean
  hint: string
}): JSX.Element {
  const body = useStore((s) => s.noteContents[path]?.body)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const viewRef = useRef<EditorView | null>(null)
  const pathRef = useRef(path)
  pathRef.current = path

  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        viewRef.current?.destroy()
        viewRef.current = null
        return
      }
      if (viewRef.current) return
      const state = EditorState.create({
        doc: useStore.getState().noteContents[path]?.body ?? '',
        extensions: buildEmbeddedNoteExtensions({
          getPath: () => pathRef.current,
          programmatic,
          keymapOverrides,
          extra: [placeholder(hint)]
        })
      })
      viewRef.current = new EditorView({ state, parent: el })
    },
    // Built once per note; the view is keyed by path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  useEffect(() => {
    const view = viewRef.current
    if (!view || body === undefined) return
    syncEmbeddedNoteBody(view, body, programmatic)
  }, [body])

  useLayoutEffect(() => {
    if (!focus) return
    const view = viewRef.current
    if (!view) return
    const end = view.state.doc.length
    view.dispatch({
      selection: EditorSelection.cursor(end),
      effects: EditorView.scrollIntoView(end, { y: 'nearest' })
    })
    const raf = requestAnimationFrame(() => {
      view.focus()
      if (useStore.getState().vimMode) {
        const cm = getCM(view)
        if (cm && !cm.state.vim?.insertMode) Vim.handleKey(cm, 'a', 'user')
      }
    })
    return () => cancelAnimationFrame(raf)
    // Read on mount only: a card that was just started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={setContainerRef} data-inline-note-view="" className="min-h-0" />
}
