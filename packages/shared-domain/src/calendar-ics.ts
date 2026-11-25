/**
 * Read meetings from an iCalendar (.ics) feed: the "secret address in iCal
 * format" Google Calendar gives for a calendar, an Outlook published
 * calendar, or an .ics file. Read-only: nothing here writes to a calendar.
 *
 * Covers what real feeds use for meetings: timed and all-day events, TZID
 * times (IANA names and the Windows names Outlook writes), floating times,
 * DURATION, RRULE (daily, weekly, monthly, yearly with INTERVAL, COUNT,
 * UNTIL, BYDAY, BYMONTHDAY), EXDATE, moved or cancelled instances
 * (RECURRENCE-ID), attendees and the organizer. Recurrences expand in the
 * event's own time zone, so a 10:00 standup stays at 10:00 across a DST change.
 *
 * No Node or DOM globals: it runs in every host.
 */

import type { CalendarEvent, CalendarPerson } from '@zennotes/bridge-contract/calendar'

export type { CalendarEvent, CalendarPerson }

interface Property {
  name: string
  params: Record<string, string>
  value: string
}

interface RawEvent {
  props: Property[]
}

const MAX_INSTANCES = 5000
const DAY_MS = 86_400_000

/** RFC 5545 line unfolding: a line that starts with a space or tab continues the last. */
function unfold(text: string): string[] {
  const out: string[] = []
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1)
    else if (line) out.push(line)
  }
  return out
}

function parseLine(line: string): Property | null {
  // The value starts at the first colon that is not inside a quoted parameter.
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (c === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const parts: string[] = []
  let current = ''
  quoted = false
  for (const c of head) {
    if (c === '"') quoted = !quoted
    if (c === ';' && !quoted) {
      parts.push(current)
      current = ''
    } else current += c
  }
  parts.push(current)
  const params: Record<string, string> = {}
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: parts[0].toUpperCase(), params, value }
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

function parseRawEvents(text: string): RawEvent[] {
  const events: RawEvent[] = []
  let current: RawEvent | null = null
  let depth = 0
  for (const line of unfold(text)) {
    const prop = parseLine(line)
    if (!prop) continue
    if (prop.name === 'BEGIN') {
      if (prop.value.toUpperCase() === 'VEVENT' && depth === 0) {
        current = { props: [] }
        continue
      }
      if (current) depth++
      continue
    }
    if (prop.name === 'END') {
      if (current && depth > 0) depth--
      else if (current && prop.value.toUpperCase() === 'VEVENT') {
        events.push(current)
        current = null
      }
      continue
    }
    // Skip properties of components nested in an event (VALARM).
    if (current && depth === 0) current.props.push(prop)
  }
  return events
}

// --- Time zones --------------------------------------------------------------

/** The Windows zone names Outlook and Exchange feeds use, for the common zones. */
const WINDOWS_ZONES: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC'
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>()

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (!zoneFormatters.has(zone)) {
    try {
      zoneFormatters.set(
        zone,
        new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      )
    } catch {
      zoneFormatters.set(zone, null)
    }
  }
  return zoneFormatters.get(zone) ?? null
}

/** An IANA zone for a TZID, or null when it names none this runtime knows. */
export function resolveTimeZone(tzid: string | undefined): string | null {
  if (!tzid) return null
  const cleaned = tzid.replace(/^\/+/, '').trim()
  const candidate = WINDOWS_ZONES[cleaned] ?? cleaned
  return formatterFor(candidate) ? candidate : null
}

/** Minutes the zone is ahead of UTC at the instant `utcMs`. */
function zoneOffsetMinutes(zone: string, utcMs: number): number {
  const formatter = formatterFor(zone)
  if (!formatter) return 0
  const parts: Record<string, number> = {}
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000)
}

interface Wall {
  y: number
  m: number // 1-12
  d: number
  hh: number
  mm: number
  ss: number
}

/** The UTC instant a wall-clock time in `zone` names. A time skipped by a DST
 *  change moves forward, as calendar apps do. */
function wallToUtc(wall: Wall, zone: string): number {
  const naive = Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm, wall.ss)
  let guess = naive - zoneOffsetMinutes(zone, naive) * 60_000
  const second = naive - zoneOffsetMinutes(zone, guess) * 60_000
  if (second !== guess) guess = Math.max(guess, second)
  return guess
}

function utcToWall(utcMs: number, zone: string): Wall {
  const shifted = new Date(utcMs + zoneOffsetMinutes(zone, utcMs) * 60_000)
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    ss: shifted.getUTCSeconds()
  }
}

// --- Dates -----------------------------------------------------------------------

interface ParsedTime {
  allDay: boolean
  wall: Wall
  /** The zone the wall time is in: an IANA name, or 'UTC'. */
  zone: string
}

function parseTime(prop: Property, defaultZone: string, raw = prop.value): ParsedTime | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(raw.trim())
  if (!match) return null
  const wall: Wall = {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
    hh: Number(match[4] ?? 0),
    mm: Number(match[5] ?? 0),
    ss: Number(match[6] ?? 0)
  }
  if (!match[4] || prop.params.VALUE === 'DATE') return { allDay: true, wall, zone: 'UTC' }
  if (match[7]) return { allDay: false, wall, zone: 'UTC' }
  return { allDay: false, wall, zone: resolveTimeZone(prop.params.TZID) ?? defaultZone }
}

function toMs(time: ParsedTime): number {
  if (time.allDay) return Date.UTC(time.wall.y, time.wall.m - 1, time.wall.d)
  return time.zone === 'UTC' ? Date.UTC(time.wall.y, time.wall.m - 1, time.wall.d, time.wall.hh, time.wall.mm, time.wall.ss)
    : wallToUtc(time.wall, time.zone)
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** `P1D`, `PT1H30M`, `-PT15M`, `P2W` in milliseconds. */
function parseDuration(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim())
  if (!match) return null
  const [, sign, w, d, h, m, s] = match
  const ms = ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 +
    Number(s ?? 0)) * 1000
  return sign === '-' ? -ms : ms
}

// --- Recurrence --------------------------------------------------------------------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  count: number | null
  untilMs: number | null
  byDay: Array<{ n: number; day: number }>
  byMonthDay: number[]
  byMonth: number[]
}

function parseRule(value: string, defaultZone: string, startZone: string): Rule | null {
  const parts = Object.fromEntries(
    value.split(';').map((part) => {
      const eq = part.indexOf('=')
      return [part.slice(0, eq).toUpperCase(), part.slice(eq + 1)]
    })
  )
  const freq = parts.FREQ?.toUpperCase()
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null
  let untilMs: number | null = null
  if (parts.UNTIL) {
    const until = parseTime({ name: 'UNTIL', params: {}, value: parts.UNTIL }, startZone === 'UTC' ? defaultZone : startZone)
    if (until) untilMs = until.allDay ? toMs(until) + DAY_MS - 1 : toMs(until)
  }
  const byDay = (parts.BYDAY ? String(parts.BYDAY).split(',') : [])
    .map((token) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ n: m[1] ? Number(m[1]) : 0, day: WEEKDAYS.indexOf(m[2].toUpperCase()) }))
  const numbers = (raw: unknown) =>
    (typeof raw === 'string' ? raw.split(',') : []).map(Number).filter((n) => Number.isInteger(n) && n !== 0)
  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL) || 1),
    count: parts.COUNT ? Math.max(0, Number(parts.COUNT) || 0) : null,
    untilMs,
    byDay,
    byMonthDay: numbers(parts.BYMONTHDAY),
    byMonth: numbers(parts.BYMONTH)
  }
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function weekday(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Days of month `y-m` that match the rule's BYDAY/BYMONTHDAY, else the start's day. */
function monthDays(rule: Rule, y: number, m: number, startDay: number): number[] {
  const count = daysInMonth(y, m)
  let days: number[]
  if (rule.byMonthDay.length) {
    days = rule.byMonthDay.map((n) => (n > 0 ? n : count + n + 1)).filter((n) => n >= 1 && n <= count)
  } else if (rule.byDay.length) {
    days = []
    for (const { n, day } of rule.byDay) {
      const matches: number[] = []
      for (let d = 1; d <= count; d++) if (weekday(y, m, d) === day) matches.push(d)
      if (n === 0) days.push(...matches)
      else {
        const pick = n > 0 ? matches[n - 1] : matches[matches.length + n]
        if (pick) days.push(pick)
      }
    }
  } else {
    days = startDay <= count ? [startDay] : []
  }
  return [...new Set(days)].sort((a, b) => a - b)
}

/** Wall-clock starts of a rule's instances, in order, the first being the event's start. */
function* ruleWalls(rule: Rule, start: Wall): Generator<Wall> {
  const at = (y: number, m: number, d: number): Wall => ({ ...start, y, m, d })
  if (rule.freq === 'DAILY') {
    for (let i = 0; ; i += rule.interval) {
      const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i))
      const wall = at(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())
      if (rule.byDay.length && !rule.byDay.some((b) => b.day === day.getUTCDay())) continue
      yield wall
    }
  }
  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay.length ? rule.byDay.map((b) => b.day) : [weekday(start.y, start.m, start.d)]
    // Weeks start on Monday (WKST default).
    const startDow = (weekday(start.y, start.m, start.d) + 6) % 7
    const weekStart = Date.UTC(start.y, start.m - 1, start.d - startDow)
    const order = [...new Set(days)].map((day) => (day + 6) % 7).sort((a, b) => a - b)
    for (let week = 0; ; week += rule.interval) {
      for (const offset of order) {
        const day = new Date(weekStart + (week * 7 + offset) * DAY_MS)
        yield at(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())
      }
    }
  }
  if (rule.freq === 'MONTHLY') {
    for (let i = 0; ; i += rule.interval) {
      const y = start.y + Math.floor((start.m - 1 + i) / 12)
      const m = ((start.m - 1 + i) % 12) + 1
      if (rule.byMonth.length && !rule.byMonth.includes(m)) continue
      for (const d of monthDays(rule, y, m, start.d)) yield at(y, m, d)
    }
  }
  if (rule.freq === 'YEARLY') {
    const months = rule.byMonth.length ? rule.byMonth : [start.m]
    for (let i = 0; ; i += rule.interval) {
      const y = start.y + i
      for (const m of [...months].sort((a, b) => a - b)) {
        const days = rule.byDay.length || rule.byMonthDay.length ? monthDays(rule, y, m, start.d)
          : start.d <= daysInMonth(y, m) ? [start.d] : []
        for (const d of days) yield at(y, m, d)
      }
    }
  }
}

function compareWall(a: Wall, b: Wall): number {
  return Date.UTC(a.y, a.m - 1, a.d, a.hh, a.mm, a.ss) - Date.UTC(b.y, b.m - 1, b.d, b.hh, b.mm, b.ss)
}

// --- Events ------------------------------------------------------------------------

function person(prop: Property | undefined): CalendarPerson | null {
  if (!prop) return null
  const email = prop.value.replace(/^mailto:/i, '').trim() || null
  const name = prop.params.CN ? unescapeText(prop.params.CN).trim() || null : null
  return name || email ? { name, email: email && email.includes('@') ? email : null } : null
}

function first(raw: RawEvent, name: string): Property | undefined {
  return raw.props.find((prop) => prop.name === name)
}

function textOf(raw: RawEvent, name: string): string | null {
  const prop = first(raw, name)
  const value = prop ? unescapeText(prop.value).trim() : ''
  return value || null
}

function instantKey(ms: number, allDay: boolean): string {
  return allDay ? isoDay(ms) : new Date(ms).toISOString()
}

export interface ReadCalendarOptions {
  /** Window to return instances for: those that overlap [from, to). */
  from: Date
  to: Date
  /** IANA zone for floating times and unknown TZIDs. Defaults to UTC. */
  defaultTimeZone?: string
}

/**
 * Every meeting instance in the feed that overlaps the window, sorted by
 * start. Cancelled events and cancelled instances are left out.
 */
export function readCalendarEvents(text: string, options: ReadCalendarOptions): CalendarEvent[] {
  const defaultZone = resolveTimeZone(options.defaultTimeZone) ?? 'UTC'
  const fromMs = options.from.getTime()
  const toMs_ = options.to.getTime()
  const raws = parseRawEvents(text)

  // Moved or cancelled instances, by UID and original start.
  const overrides = new Map<string, RawEvent>()
  for (const raw of raws) {
    const rid = first(raw, 'RECURRENCE-ID')
    const uid = textOf(raw, 'UID')
    if (!rid || !uid) continue
    const time = parseTime(rid, defaultZone)
    if (time) overrides.set(`${uid}\u0000${toMs(time)}`, raw)
  }

  const out: CalendarEvent[] = []
  const build = (raw: RawEvent, uid: string, startMs: number, durationMs: number, allDay: boolean,
    recurring: boolean, originalMs: number): void => {
    if ((textOf(raw, 'STATUS') ?? '').toUpperCase() === 'CANCELLED') return
    const endMs = startMs + durationMs
    const overlaps = durationMs > 0 ? startMs < toMs_ && endMs > fromMs : startMs >= fromMs && startMs < toMs_
    if (!overlaps) return
    out.push({
      uid,
      key: recurring ? `${uid}@${instantKey(originalMs, allDay)}` : uid,
      title: textOf(raw, 'SUMMARY') ?? 'Untitled meeting',
      start: instantKey(startMs, allDay),
      end: instantKey(endMs, allDay),
      allDay,
      location: textOf(raw, 'LOCATION'),
      description: textOf(raw, 'DESCRIPTION'),
      url: textOf(raw, 'URL'),
      organizer: person(first(raw, 'ORGANIZER')),
      attendees: raw.props
        .filter((prop) => prop.name === 'ATTENDEE')
        .map(person)
        .filter((p): p is CalendarPerson => !!p),
      recurring
    })
  }

  for (const raw of raws) {
    if (first(raw, 'RECURRENCE-ID')) continue
    const uid = textOf(raw, 'UID')
    const dtstart = first(raw, 'DTSTART')
    if (!uid || !dtstart) continue
    const start = parseTime(dtstart, defaultZone)
    if (!start) continue
    const startMs = toMs(start)
    const dtend = first(raw, 'DTEND')
    const end = dtend ? parseTime(dtend, defaultZone) : null
    const duration = first(raw, 'DURATION')
    const durationMs = end ? Math.max(0, toMs(end) - startMs)
      : duration ? Math.max(0, parseDuration(duration.value) ?? 0)
        : start.allDay ? DAY_MS : 0

    const rruleProp = first(raw, 'RRULE')
    const rule = rruleProp ? parseRule(rruleProp.value, defaultZone, start.zone) : null
    if (!rule) {
      build(raw, uid, startMs, durationMs, start.allDay, false, startMs)
      continue
    }

    const excluded = new Set<number>()
    for (const prop of raw.props.filter((p) => p.name === 'EXDATE')) {
      for (const value of prop.value.split(',')) {
        const time = parseTime(prop, start.zone === 'UTC' && !start.allDay ? defaultZone : start.zone, value)
        if (time) excluded.add(toMs(time.allDay || start.allDay ? { ...time, allDay: start.allDay } : time))
      }
    }
    // An instance's wall time is in the start's own zone; a UTC start repeats in UTC.
    const zone = start.allDay ? 'UTC' : start.zone
    const startWall = start.allDay || zone === 'UTC' ? start.wall : utcToWall(startMs, zone)
    let emitted = 0
    let iterations = 0
    for (const wall of ruleWalls(rule, startWall)) {
      if (++iterations > MAX_INSTANCES * 4) break
      if (compareWall(wall, startWall) < 0) continue
      const instanceMs = start.allDay ? Date.UTC(wall.y, wall.m - 1, wall.d)
        : zone === 'UTC' ? Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm, wall.ss)
          : wallToUtc(wall, zone)
      if (rule.untilMs !== null && instanceMs > rule.untilMs) break
      if (rule.count !== null && emitted >= rule.count) break
      emitted++
      if (emitted > MAX_INSTANCES) break
      // A little past the window, so an instance moved into it from just after is still seen.
      if (instanceMs >= toMs_ + 31 * DAY_MS) break
      if (excluded.has(instanceMs)) continue
      const override = overrides.get(`${uid}\u0000${instanceMs}`)
      if (override) {
        const os = first(override, 'DTSTART')
        const ostart = os ? parseTime(os, defaultZone) : null
        const oend = first(override, 'DTEND')
        const oendTime = oend ? parseTime(oend, defaultZone) : null
        const oStartMs = ostart ? toMs(ostart) : instanceMs
        const oDuration = oendTime ? Math.max(0, toMs(oendTime) - oStartMs) : durationMs
        build(override, uid, oStartMs, oDuration, ostart?.allDay ?? start.allDay, true, instanceMs)
        continue
      }
      if (instanceMs + Math.max(durationMs, 1) <= fromMs) continue
      build(raw, uid, instanceMs, durationMs, start.allDay, true, instanceMs)
    }
  }

  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)))
}
