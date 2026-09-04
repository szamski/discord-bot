import { type Client, Events } from "discord.js";

import { captureForGuild, toPersonLike } from "@/capture.js";
import { guildProps } from "@/props.js";

/** Thread creation events. */
export function register(client: Client): void {
  client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
    // `newlyCreated` is false when the bot simply gains access to an existing
    // thread (e.g. on startup) — only count genuinely new threads.
    if (!newlyCreated) return;

    const ownerId = thread.ownerId;
    if (!ownerId) return; // Can't attribute without an owner.

    // Pass the owner as the actor so the thread's author gets person properties
    // (incl. the `name` PostHog displays). A forum post is often the only event
    // behind a Support ticket, so without this the reporter shows as a raw id.
    // Fetched rather than read from cache: a thread can be the first thing the
    // bot ever sees from this user, and cache would then be empty.
    const owner = await thread.client.users.fetch(ownerId).catch(() => null);

    captureForGuild({
      guildId: thread.guild.id,
      event: "thread_created",
      distinctId: ownerId,
      actor: owner ? toPersonLike(owner) : undefined,
      properties: {
        ...guildProps(thread.guild),
        thread_id: thread.id,
        thread_name: thread.name,
        parent_channel_id: thread.parentId,
        parent_channel_name: thread.parent?.name ?? null,
      },
    });
  });
}
