/**
 * Meetings read from the person's calendar feeds, for notes on meetings.
 * Read-only: no host sends, accepts or changes an invite through this.
 */

export interface CalendarPerson {
  name: string | null
  email: string | null
}

export interface CalendarEvent {
  /** The event's UID. Every instance of a recurring event shares it. */
  uid: string
  /** Stable across reads and unique per instance: the UID, plus the
   *  instance's original start for a recurring event. */
  key: string
  title: string
  /** ISO 8601 in UTC for a timed event; `YYYY-MM-DD` for an all-day one. */
  start: string
  end: string
  allDay: boolean
  location: string | null
  description: string | null
  url: string | null
  organizer: CalendarPerson | null
  attendees: CalendarPerson[]
  recurring: boolean
}

export interface CalendarMeeting extends CalendarEvent {
  feedId: string
  feedName: string
}

export interface CalendarFeedSummary {
  id: string
  name: string
  /** Only the host name: a feed's full address is a secret (Google's
   *  "secret address in iCal format") and stays in system storage. */
  host: string
}

export interface CalendarMeetingsResult {
  meetings: CalendarMeeting[]
  /** Feeds that could not be read this time, with words for the person. */
  failures: Array<{ feedId: string; feedName: string; message: string }>
}

/**
 * Every calendar one vault can show meetings from: the .ics feeds this device
 * keeps, plus the device's own calendars (EventKit on iPhone) once the person
 * allows calendar access. Each vault keeps its own choice on each device,
 * because a device calendar's identifier means nothing on another device.
 */
export type CalendarSourceKind = 'feed' | 'device'

/** Where the device's own calendars stand. `unsupported`: this host cannot
 *  read them. `write-only`: iOS 17's "Add Events Only", which reads nothing. */
export type DeviceCalendarAccess =
  | 'unsupported'
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'write-only'

export interface CalendarSource {
  /** `feed:<id>` or `device:<calendar identifier>`. */
  id: string
  kind: CalendarSourceKind
  name: string
  /** The feed's host, or the account a device calendar belongs to ("iCloud"). */
  detail: string | null
  /** `#rrggbb` when the device gives one. */
  color: string | null
  selected: boolean
}

export interface CalendarSourcesResult {
  /** The open vault the choice belongs to, or null when none is open. */
  vaultName: string | null
  /** False while the vault has no choice of its own: it then shows every calendar. */
  customized: boolean
  device: {
    access: DeviceCalendarAccess
    /** "iPhone", "iPad", "computer". */
    label: string
    /** Why the device's calendars could not be listed this time. */
    error: string | null
  }
  sources: CalendarSource[]
}

/** One of the device's own calendars, as the host lists it. */
export interface DeviceCalendarInfo {
  id: string
  name: string
  account: string | null
  color: string | null
}

/** One event (or one instance of a recurring one) from a device calendar. */
export interface DeviceCalendarEvent extends CalendarEvent {
  calendarId: string
}

/**
 * What a host gives for its own calendars. Read-only: nothing here can add,
 * change or answer an event.
 */
export interface DeviceCalendarsHost {
  access(): Promise<DeviceCalendarAccess>
  /** Shows the system's question once; answers with where access stands. */
  requestAccess(): Promise<DeviceCalendarAccess>
  calendars(): Promise<DeviceCalendarInfo[]>
  /** Events overlapping [fromIso, toIso) in the given calendars. */
  events(options: { fromIso: string; toIso: string; calendarIds: string[] }): Promise<DeviceCalendarEvent[]>
  /** Opens this app's page in the system Settings, where access is changed after a no. */
  openSettings?(): Promise<void>
}
