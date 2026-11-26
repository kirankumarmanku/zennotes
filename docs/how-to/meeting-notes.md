# Notes on meetings

ZenNotes can show the meetings from your calendars in the calendar panel and
start a note for any of them, with the meeting's time, place, organizer and
guests already filled in.

ZenNotes only reads your calendars. It never sends, accepts or changes an
invite, and it never signs in to your calendar account.

## Add a calendar

1. Copy your calendar's .ics address.
   - **Google Calendar:** Settings, then the calendar under "Settings for my
     calendars", then "Integrate calendar", then "Secret address in iCal format".
   - **Outlook:** Settings, then Calendar, then "Shared calendars", then
     "Publish a calendar". Copy the ICS link.
   - **Apple iCloud:** share the calendar as a public calendar and copy its
     webcal:// link.
2. In ZenNotes, open Settings, then Vault, then **Calendars**.
3. Give it a name, paste the address and press **Add calendar**.

The address is a secret: anyone who has it can read that calendar. ZenNotes
keeps it in your system's secure storage (Keychain, Credential Manager or the
Secret Service) and shows only its name and host afterwards. To revoke it,
reset the secret address in your calendar's settings and remove it here.

## Use your iPhone's calendars

On iPhone, Settings, then Vault, then **Calendars** also lists every calendar
in the Calendar app (iCloud, Google, Exchange and subscribed calendars). Press
**Allow calendar access** and choose **Allow Full Access**: "Add Events Only"
can't read events. ZenNotes only reads them. If you said no earlier, turn it
on under iOS Settings, Privacy & Security, Calendars.

## Choose the calendars for each vault

Each vault has its own ticks in **Calendars**, so a work vault can show your
work calendar and a personal vault your family one. The choice is kept on each
device, because a calendar on your iPhone isn't the same object on your Mac.

- A vault starts with no calendars ticked, so it shows no meetings until you
  tick the ones you want. **All** ticks every calendar at once.
- A calendar you add by address from a vault's settings is ticked in that
  vault only.
- Removing a calendar removes it from every vault. Notes you wrote stay.

## Write notes on a meeting

Open the calendar panel. The week under the month grid lists each day's
meetings above its tasks. Click a meeting to open its note, or to start one.

The note is saved as `Inbox/Meetings/2026-11-25 1000 Design review.md` and
starts like this:

```markdown
---
type: meeting
event_key: "7kq…@google.com@2026-11-25T15:00:00.000Z"
event_title: Design review
event_start: "2026-11-25T15:00:00.000Z"
event_end: "2026-11-25T16:00:00.000Z"
location: Room 4
organizer: Priya <priya@example.com>
attendees:
  - Dev <dev@example.com>
---

# Design review

**When:** Wed, Nov 25, 10:00 AM to 11:00 AM
**Where:** Room 4
**Organizer:** Priya <priya@example.com>
**With:** Dev <dev@example.com>

## Agenda
## Notes
## Action items
```

Clicking the same meeting again opens the same note. Each instance of a
recurring meeting gets its own note.

To use your own layout, add a template named **Meeting**. Its body replaces
the Agenda, Notes and Action items sections; the frontmatter and the meeting
details still come first.

Tasks in a meeting note show in the task views like any other.

## Details

- Calendars are read again every five minutes. When a calendar can't be
  reached, the last copy read is used.
- Recurring meetings, moved and cancelled instances, and time zones (including
  Outlook's Windows zone names) are handled.
- A meeting note syncs like any other note, including with S3 sync.
- The macOS Calendar app is not read yet. On a Mac, add calendars by address;
  each vault still picks which of them it shows.
