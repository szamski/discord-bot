import { getTicketForThread, linkTicket } from "@/db.js";
import { nowMs } from "@/time.js";
import { createTicket, replyToTicket, ticketsEnabled } from "@/tickets/client.js";

/**
 * Discord → PostHog Support. Turns a watched forum's posts into tickets and
 * their replies into messages on the linked ticket.
 *
 * Both entry points are no-ops when the tickets integration isn't configured,
 * so the bot's existing behaviour is unchanged unless env opts in.
 */

/** The Discord author of a forum post or reply. */
export interface TicketAuthor {
  id: string;
  username: string;
  globalName: string | null;
}

/** How an author is labelled inside ticket messages. */
function authorLabel(author: TicketAuthor): string {
  return author.globalName
    ? `${author.globalName} (@${author.username})`
    : `@${author.username}`;
}

/**
 * Open a ticket for a new forum post and link it to the thread. Idempotent per
 * thread: if a link already exists (duplicate ThreadCreate, or a restart racing
 * the gateway) no second ticket is opened.
 */
export async function openTicketForPost(args: {
  guildId: string;
  threadId: string;
  title: string;
  content: string;
  tags: string[];
  author: TicketAuthor;
}): Promise<void> {
  if (!ticketsEnabled()) return;
  if (getTicketForThread(args.threadId)) return;

  const tagLine = args.tags.length ? `\n\nTags: ${args.tags.join(", ")}` : "";
  const ticket = await createTicket({
    title: args.title,
    message: `${args.content}${tagLine}\n\n— from Discord, posted by ${authorLabel(args.author)}`,
    authorName: authorLabel(args.author),
    discordUserId: args.author.id,
  });
  if (!ticket) return;

  // Re-check before writing: the await above is a window in which a concurrent
  // ThreadCreate could have linked this thread already.
  const linked = linkTicket(
    args.guildId,
    args.threadId,
    ticket.id,
    ticket.ticketNumber,
    nowMs()
  );
  if (!linked) {
    console.warn(
      `[tickets] thread ${args.threadId} was linked concurrently; ticket ${ticket.id} is now orphaned.`
    );
    return;
  }
  console.log(
    `[tickets] opened ticket ${ticket.ticketNumber ?? ticket.id} for thread ${args.threadId}.`
  );
}

/**
 * Append a forum reply to the thread's ticket, as an internal note — see
 * {@link replyToTicket} for why inbound Discord content is never a public reply.
 */
export async function addReplyToTicket(args: {
  threadId: string;
  content: string;
  author: TicketAuthor;
}): Promise<void> {
  if (!ticketsEnabled()) return;

  const link = getTicketForThread(args.threadId);
  if (!link) return; // Thread predates the integration, or its ticket failed to open.

  await replyToTicket({
    ticketId: link.ticketId,
    message: `${authorLabel(args.author)} in Discord:\n\n${args.content}`,
    isPrivate: true,
  });
}
