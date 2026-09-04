import {
  ChannelType,
  type ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";

import {
  addWatchedForum,
  listWatchedForumsWithTags,
  removeWatchedForum,
} from "@/db.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

/** `/ph forums watch <channel>` → start forwarding new posts from a forum. */
export async function handleForumsWatch(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guildId) return;
  const channel = interaction.options.getChannel("channel", true);

  // The option is restricted to forum channels, but re-check so a stale/odd
  // selection can't slip through.
  if (channel.type !== ChannelType.GuildForum) {
    await interaction.reply({
      content: "❌ That isn't a forum channel.",
      ...EPHEMERAL,
    });
    return;
  }

  // Optional PostHog Support tag applied to tickets opened from this forum.
  // Re-running watch with a different tag updates it.
  const tag = interaction.options.getString("tag")?.trim() || null;
  const added = addWatchedForum(interaction.guildId, channel.id, tag);
  const tagNote = tag ? ` Tickets from it are tagged \`${tag}\`.` : "";
  await interaction.reply({
    content: added
      ? `✅ Now forwarding new posts in <#${channel.id}> to PostHog Code.${tagNote}`
      : `<#${channel.id}> is already being watched.${
          tag ? ` Tag updated to \`${tag}\`.` : " Its tag was cleared."
        }`,
    ...EPHEMERAL,
  });
}

/** `/ph forums unwatch <channel>` → stop forwarding posts from a forum. */
export async function handleForumsUnwatch(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guildId) return;
  const channel = interaction.options.getChannel("channel", true);

  const removed = removeWatchedForum(interaction.guildId, channel.id);
  await interaction.reply({
    content: removed
      ? `🛑 Stopped forwarding posts in <#${channel.id}>.`
      : `<#${channel.id}> wasn't being watched.`,
    ...EPHEMERAL,
  });
}

/** `/ph forums list` → show the watched forum channels. */
export async function handleForumsList(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guildId) return;
  const forums = listWatchedForumsWithTags(interaction.guildId);

  await interaction.reply({
    content:
      forums.length === 0
        ? "No forums are being watched. Add one with `/ph forums watch`."
        : `📋 Watching ${forums.length} forum(s):\n` +
          forums
            .map(
              (f) =>
                `• <#${f.channelId}>` +
                (f.ticketTag ? ` — tag \`${f.ticketTag}\`` : "")
            )
            .join("\n"),
    ...EPHEMERAL,
  });
}
