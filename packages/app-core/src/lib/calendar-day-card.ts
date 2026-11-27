/**
 * Where the Calendar's day card goes. The card is the day's note, open to
 * read and write, so it may not cover the days the pointer moves on to: on a
 * wide window it sits beside the panel, level with the day, as the hover
 * preview it replaced did. Where there is no room beside the panel (a phone,
 * or a panel filling the window) it docks across the top, clear of the
 * keyboard that rises from the bottom when you type.
 */

export interface RectLike {
  left: number
  right: number
  top: number
  bottom: number
}

export interface DayCardPlacement {
  left: number
  width: number
  /** Pixels from the top; for a docked card, from below the top safe area. */
  top: number
  maxHeight: number
  docked: boolean
}

const EDGE = 12
const GAP = 14
const WIDTH = 400
const MAX_HEIGHT = 460
/** Below this width a card beside the panel would be a sliver. */
const BESIDE_MIN_VIEWPORT = 640

export function dayCardPlacement(
  panel: RectLike,
  day: RectLike,
  viewport: { width: number; height: number }
): DayCardPlacement {
  const vw = viewport.width
  const vh = viewport.height
  const width = Math.min(WIDTH, vw - EDGE * 2)
  const maxHeight = Math.max(160, Math.min(MAX_HEIGHT, vh - EDGE * 2))
  const top = Math.max(EDGE, Math.min(day.top - EDGE, vh - EDGE - maxHeight))
  if (vw >= BESIDE_MIN_VIEWPORT) {
    if (panel.left - GAP - width >= EDGE) {
      return { left: panel.left - GAP - width, width, top, maxHeight, docked: false }
    }
    if (panel.right + GAP + width <= vw - EDGE) {
      return { left: panel.right + GAP, width, top, maxHeight, docked: false }
    }
  }
  return {
    left: EDGE,
    width: vw - EDGE * 2,
    top: EDGE,
    maxHeight: Math.max(160, Math.min(MAX_HEIGHT, Math.round(vh * 0.45))),
    docked: true
  }
}
