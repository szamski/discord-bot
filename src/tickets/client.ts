import { createHash } from "node:crypto";

import { config, type TicketsConfig } from "@/config.js";

/**
 * Client for PostHog Support (Conversations).
 *
 * Opening a ticket goes through the **widget** endpoint the browser SDK uses
 * (`posthog.conversations.sendMessage`), because the REST route
 * `POST /api/projects/:id/conversations/tickets/` answers 405 and points at the
 * SDK — there is no documented server-side create.
 *
 * That endpoint authenticates with the project's **public** conversations token
 * plus an `Origin` on the project's Support domain allowlist, so no personal API
 * key is involved in creating tickets. Replying to an existing ticket still uses
 * the documented REST route, which needs a personal API key (`ticket:write`).
 *
 * Caveat worth knowing: the widget endpoint is not part of PostHog's documented
 * API. It can change without notice, in which case creates start failing loudly
 * in the logs and Discord carries on unaffected.
 */

const TIMEOUT_MS = 10_000;

/** PostHog caps a message at 5000 characters. */
export const MAX_MESSAGE_CHARS = 5000;

export interface CreatedTicket {
  id: string;
  /** The widget endpoint returns no ticket number; kept for the REST shape. */
  ticketNumber: number | null;
}

/** Is the tickets integration configured at all? */
export function ticketsEnabled(): boolean {
  return config.tickets !== undefined;
}

/** Truncate to PostHog's limit, marking the cut so it's obvious in the ticket. */
export function clampMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const suffix = "\n\n[truncated]";
  return text.slice(0, MAX_MESSAGE_CHARS - suffix.length) + suffix;
}

/**
 * A stable widget session for a Discord user, so every ticket that person opens
 * belongs to one conversation session instead of a fresh anonymous one.
 *
 * Derived as a UUIDv5-shaped digest of the user id — deterministic, no state to
 * store, and it reveals nothing about the id itself.
 */
export function widgetSessionId(discordUserId: string): string {
  const h = createHash("sha1").update(`discord:${discordUserId}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** PostHog distinct id for a Discord user — matches the analytics namespace. */
export const distinctIdFor = (discordUserId: string): string => discordUserId;

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open a ticket for a Discord forum post via the widget endpoint. Returns null
 * on any failure (logged); the caller keeps working without a ticket link
 * rather than dropping the post.
 */
export async function createTicket(args: {
  /** Forum post title — leads the first message, as the API has no subject. */
  title: string;
  message: string;
  /** Display name shown on the ticket. */
  authorName: string;
  /** Discord user id — becomes the distinct id and seeds the widget session. */
  discordUserId: string;
}): Promise<CreatedTicket | null> {
  const cfg = config.tickets;
  if (!cfg) return null;

  const message = clampMessage(`**${args.title}**\n\n${args.message}`);

  try {
    const res = await postJson(
      `${cfg.captureHost}/api/conversations/v1/widget/message`,
      {
        "X-Conversations-Token": cfg.conversationsToken,
        // Required: the endpoint enforces the project's Support domain
        // allowlist server-side. Must be a domain listed there.
        Origin: cfg.origin,
      },
      {
        message,
        widget_session_id: widgetSessionId(args.discordUserId),
        // The API rejects widget_session_id without a distinct_id.
        distinct_id: distinctIdFor(args.discordUserId),
        user_traits: { name: args.authorName },
      }
    );
    if (!res.ok) {
      console.error(
        `[tickets] create failed: ${res.status} ${await res.text().catch(() => "")}`
      );
      return null;
    }
    const data = (await res.json()) as { ticket_id?: unknown };
    if (typeof data.ticket_id !== "string") {
      console.error("[tickets] create returned no ticket_id.");
      return null;
    }
    return { id: data.ticket_id, ticketNumber: null };
  } catch (err) {
    console.error("[tickets] create failed:", err);
    return null;
  }
}

/**
 * Append a message to an existing ticket over the documented REST route.
 *
 * `isPrivate` matters. With `is_private: false` PostHog **delivers** the message
 * to the customer over the ticket's own channel; a Discord-sourced ticket has no
 * such channel that reaches the poster, so inbound Discord content is stored as
 * an internal note instead. Requires `restApiKey`; without one this is a no-op.
 */
export async function replyToTicket(args: {
  ticketId: string;
  message: string;
  isPrivate: boolean;
}): Promise<boolean> {
  const cfg = config.tickets;
  if (!cfg?.restApiKey || !cfg.projectId) {
    console.warn(
      "[tickets] reply skipped: POSTHOG_TICKETS_API_KEY / _PROJECT_ID not set."
    );
    return false;
  }

  try {
    const res = await postJson(
      `${cfg.appHost}/api/projects/${cfg.projectId}/conversations/tickets/${encodeURIComponent(args.ticketId)}/reply/`,
      { Authorization: `Bearer ${cfg.restApiKey}` },
      { message: clampMessage(args.message), is_private: args.isPrivate }
    );
    if (!res.ok) {
      console.error(
        `[tickets] reply failed: ${res.status} ${await res.text().catch(() => "")}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[tickets] reply failed:", err);
    return false;
  }
}
