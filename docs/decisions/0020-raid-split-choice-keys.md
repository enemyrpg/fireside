# 0020. Raid split choices keep their drop

- **Date:** 2026-11-26
- **Status:** Accepted

## Context

The raid split tracker stores the owner's choices for a drop (mode, own
value, party size, nickname, note) in `raid_drop_choices`. They are typed by
hand and can't be rebuilt from raw events
([ADR 0003](0003-raw-events-and-projections.md)). They are keyed by derived
rows, though. An own purple is keyed by its `raid.special_loot` event, and a
purple known only from the chest by the chest's `loot` event and the item's
position. Which chest a `SELF` event is matched with can change as events
arrive. When an event comes before its own chest, it is matched for a while
with another chest of the same item. So a choice moved automatically on
ingest, retry or rebuild can end up on the wrong drop for good. And a choice
whose drop is gone stays where nobody can see or clear it. For a nickname,
that goes against [ADR 0006](0006-no-data-about-other-players.md).

## Decision

- **Choices never move on ingest, retry or rebuild.** A drop reads both its
  keys. If both have a row, they are merged when read, field by field: the row
  changed last wins, but an empty field never replaces a filled one
  (`server/src/read/raid-splits.ts`, `mergeChoices` in
  `server/src/raids/choice-keys.ts`).
- **The owner's edit collapses them.** What the owner saw (both rows merged)
  plus the change is stored as the whole row under the drop's event key, and
  the chest row is deleted in the same transaction. A field the owner clears
  stays cleared (`server/src/raids/choices.ts`).
- **A rule change that re-matches drops moves choices first.** The upgrade to
  nearest-chest matching (`raid-special-loot` version 2) moves every
  chest-key row whose drop has an event to that event key, while the version 1
  rows are still there. This happens in the projection's `beforeUpgrade`
  hook, also before a fallback full rebuild. So each choice stays on the drop
  the owner saw.
- **Only a choice whose drop is definitely gone is deleted.** That means its
  raw event was projected without an error, and no drop has its key, as an
  event key or as a chest key. This runs after a rebuild, after a retry that
  projected at least one event, and in the upgrade. A failed or pending event
  never loses its choices. The log gets a count, never the text.

## Consequences

- Rebuilds no longer leave non-derived tables untouched: they may delete
  choices of drops that are gone. They never move or edit a choice.
- A chest-key choice shows on whichever drop that chest is matched with now.
  While an event waits for its own chest, it may briefly show another chest's
  choice. Once the right chest arrives, the choice is back on its own drop.
- An edit made during that window is the owner's choice for the drop they
  saw: it collapses that chest's row into the event's.
- `check-migration` works out the rows an upgrade should leave (moved,
  merged, gone) and fails on any other difference. It reports counts only.
- Details: [architecture.md](../architecture.md#raid-split-choices).
