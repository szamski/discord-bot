/**
 * The forum tags that mirror a PostHog Support ticket's status.
 *
 * Shared because two sides need the same list: the actions API swaps these tags
 * when a ticket's status changes, and ticket creation filters them out of the
 * post's tag list — they describe our own state, not what the reporter said.
 */

/** PostHog Support status → the forum tag that represents it. */
export const STATUS_TAG_NAMES: Record<string, string> = {
  new: "New",
  open: "Open",
  pending: "Pending",
  on_hold: "On hold",
  resolved: "Resolved",
};

/**
 * Compare tag names forgivingly: a Discord tag is typed by hand ("On hold",
 * "on-hold") while PostHog's status is snake_case.
 */
export const normalizeTagName = (name: string): string =>
  name.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

export const sameTagName = (a: string, b: string): boolean =>
  normalizeTagName(a) === normalizeTagName(b);

const STATUS_TAG_SET = new Set(
  Object.values(STATUS_TAG_NAMES).map(normalizeTagName)
);

/** Is this forum tag one of the status tags the bot manages? */
export const isStatusTagName = (name: string): boolean =>
  STATUS_TAG_SET.has(normalizeTagName(name));
