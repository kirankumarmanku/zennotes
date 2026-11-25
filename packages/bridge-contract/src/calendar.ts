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
