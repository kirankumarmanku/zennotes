import { describe, expect, it } from 'vitest'
import { dayCardPlacement } from './calendar-day-card'

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })

describe('dayCardPlacement', () => {
  it('sits left of a right-hand panel, level with the day', () => {
    const p = dayCardPlacement(rect(1100, 0, 1400, 900), rect(1120, 300, 1160, 340), { width: 1400, height: 900 })
    expect(p.docked).toBe(false)
    expect(p.left + p.width).toBeLessThanOrEqual(1100)
    expect(p.top).toBe(288)
  })

  it('keeps the whole card on screen for a day near the bottom', () => {
    const p = dayCardPlacement(rect(1100, 0, 1400, 900), rect(1120, 860, 1160, 890), { width: 1400, height: 900 })
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(900 - 12)
  })

  it('goes right of a panel that has no room on its left', () => {
    const p = dayCardPlacement(rect(0, 0, 320, 900), rect(20, 200, 60, 240), { width: 1400, height: 900 })
    expect(p.docked).toBe(false)
    expect(p.left).toBeGreaterThanOrEqual(320)
  })

  it('docks across the top on a phone, clear of the keyboard', () => {
    const p = dayCardPlacement(rect(0, 0, 390, 844), rect(100, 500, 150, 550), { width: 390, height: 844 })
    expect(p).toEqual({ left: 12, width: 366, top: 12, maxHeight: 380, docked: true })
  })
})
