import { describe, expect, it } from 'vitest'
import type { CalendarSource, CalendarSourcesResult } from '@zennotes/bridge-contract/calendar'
import { deviceAccessText, groupCalendarSources, toggledSelection } from './CalendarFeedsSettings'

const sources: CalendarSource[] = [
  { id: 'device:a', kind: 'device', name: 'Home', detail: 'iCloud', color: '#ff2968', selected: true },
  { id: 'feed:f', kind: 'feed', name: 'Team', detail: 'calendar.example.com', color: null, selected: false },
  { id: 'device:b', kind: 'device', name: 'Work', detail: 'Gmail', color: null, selected: false },
  { id: 'device:c', kind: 'device', name: 'Family', detail: 'iCloud', color: null, selected: true }
]

function result(access: CalendarSourcesResult['device']['access']): CalendarSourcesResult {
  return { vaultName: 'Work', customized: false, device: { access, label: 'iPhone', error: null }, sources }
}

describe('calendar settings', () => {
  it('groups device calendars by account and puts feeds last', () => {
    expect(groupCalendarSources(sources).map((group) => [group.title, group.sources.map((s) => s.id)])).toEqual([
      ['iCloud', ['device:a', 'device:c']],
      ['Gmail', ['device:b']],
      ['Added by address', ['feed:f']]
    ])
  })

  it('ticks or unticks one calendar and keeps the rest', () => {
    expect(toggledSelection(sources, 'device:b', true)).toEqual(['device:a', 'device:b', 'device:c'])
    expect(toggledSelection(sources, 'device:a', false)).toEqual(['device:c'])
  })

  it('says what to do for each kind of calendar access', () => {
    expect(deviceAccessText(result('granted'))).toBeNull()
    expect(deviceAccessText(result('unsupported'))).toBeNull()
    expect(deviceAccessText(result('not-determined'))).toMatch(/iPhone’s calendars/)
    expect(deviceAccessText(result('denied'))).toMatch(/Full Access/)
    expect(deviceAccessText(result('write-only'))).toMatch(/only add events/)
    expect(deviceAccessText(result('restricted'))).toMatch(/restricted/)
  })
})
