// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The inline note editors (Home's today card, the Calendar's day card) edit a
 * note no pane has open. The store has to keep that note's buffer through
 * the cache prunes a listing does, save it as the editor goes, and only then
 * let it go.
 */

let vault: Map<string, string>

function meta(path: string, body: string) {
  return {
    path,
    title: path,
    folder: 'inbox' as const,
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 1,
    size: body.length,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: body.slice(0, 40)
  }
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  vault = new Map([['Daily Notes/2026-11-27.md', 'Morning.\n']])
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getCapabilities: () => ({ supportsRemoteWorkspace: false }),
      listNotes: async () => [...vault].map(([path, body]) => meta(path, body)),
      listFolders: async () => [],
      listAssets: async () => [],
      listLocalVaults: async () => [],
      hasAssetsDir: async () => false,
      getRemoteWorkspaceInfo: async () => null,
      scanTasks: async () => [],
      scanTasksForPath: async () => [],
      readNote: async (path: string) => {
        const body = vault.get(path)
        if (body === undefined) throw new Error(`Missing note: ${path}`)
        return { ...meta(path, body), body }
      },
      writeNote: vi.fn(async (path: string, body: string) => {
        vault.set(path, body)
        return meta(path, body)
      })
    }
  })
})

async function setup() {
  const { useStore } = await import('./store')
  useStore.setState({ notes: [...vault].map(([path, body]) => meta(path, body)) })
  return useStore
}

const path = 'Daily Notes/2026-11-27.md'

describe('inline note editors hold their note in the shared buffer', () => {
  it('reads the note in, and keeps it through a listing', async () => {
    const useStore = await setup()
    expect(await useStore.getState().holdInlineNote(path)).toBe(true)
    expect(useStore.getState().noteContents[path]?.body).toBe('Morning.\n')
    await useStore.getState().refreshNotes()
    expect(useStore.getState().noteContents[path]?.body).toBe('Morning.\n')
    useStore.getState().updateNoteBody(path, 'Morning.\nCoffee with Sam.\n')
    await useStore.getState().refreshNotes()
    expect(useStore.getState().noteContents[path]?.body).toBe('Morning.\nCoffee with Sam.\n')
  })

  it('saves the last edit as the editor lets go, then drops the buffer', async () => {
    const useStore = await setup()
    await useStore.getState().holdInlineNote(path)
    useStore.getState().updateNoteBody(path, 'Morning.\nCalled the bank.\n')
    useStore.getState().releaseInlineNote(path)
    await vi.waitFor(() => expect(vault.get(path)).toBe('Morning.\nCalled the bank.\n'))
    await vi.waitFor(() => expect(useStore.getState().noteContents[path]).toBeUndefined())
  })

  it('keeps the buffer while a second editor still shows the note', async () => {
    const useStore = await setup()
    await useStore.getState().holdInlineNote(path)
    await useStore.getState().holdInlineNote(path)
    useStore.getState().releaseInlineNote(path)
    await useStore.getState().refreshNotes()
    expect(useStore.getState().noteContents[path]?.body).toBe('Morning.\n')
    useStore.getState().releaseInlineNote(path)
    await vi.waitFor(() => expect(useStore.getState().noteContents[path]).toBeUndefined())
  })
})
