import type { AddressInfo } from "node:net";

import { DiscordAPIError, Routes } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rest } = vi.hoisted(() => ({
  rest: { post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn(), get: vi.fn() },
}));
vi.mock("@/bridge/discordRest.js", () => ({ rest }));

const { createActionsServer, handleAction } = await import("@/bridge/actionsServer.js");
const { readGuildConfig, isWatchedThread } = await import("@/db.js"); // real in-memory SQLite

// vitest.config sets DISCORD_APPLICATION_ID = "test-app".
const APP = "test-app";

beforeEach(() => vi.clearAllMocks());

describe("handleAction", () => {
  it("create_thread off a message", async () => {
    rest.post.mockResolvedValue({ id: "t1" });
    const res = await handleAction("create_thread", {
      channel_id: "c",
      message_id: "m",
      name: "Topic",
    });
    expect(rest.post).toHaveBeenCalledWith(Routes.threads("c", "m"), { body: { name: "Topic" } });
    expect(res).toEqual({ status: 200, body: { thread_id: "t1" } });
  });

  it("create_thread on a channel that is already a thread reuses it", async () => {
    rest.post.mockRejectedValue(
      new DiscordAPIError(
        { message: "Cannot execute action on this channel type", code: 50024 },
        50024,
        400,
        "POST",
        "https://discord.com/api/v10/channels/c/threads",
        { body: {} }
      )
    );
    const res = await handleAction("create_thread", { channel_id: "c", name: "Topic" });
    expect(res).toEqual({ status: 200, body: { thread_id: "c" } });
  });

  it("create_thread rethrows unrelated Discord errors", async () => {
    rest.post.mockRejectedValue(
      new DiscordAPIError(
        { message: "Missing Access", code: 50001 },
        50001,
        403,
        "POST",
        "https://discord.com/api/v10/channels/c/threads",
        { body: {} }
      )
    );
    await expect(handleAction("create_thread", { channel_id: "c", name: "Topic" })).rejects.toThrow();
  });

  it("post_message to a channel uses bot auth", async () => {
    rest.post.mockResolvedValue({ id: "m1" });
    const res = await handleAction("post_message", { target_id: "c", content: "hi" });
    expect(rest.post).toHaveBeenCalledWith(Routes.channelMessages("c"), {
      body: { content: "hi", embeds: undefined, components: undefined },
      auth: true,
    });
    expect(res.body).toEqual({ message_id: "m1" });
  });

  it("post_message via interaction token is ephemeral + unauthenticated", async () => {
    rest.post.mockResolvedValue({ id: "m2" });
    await handleAction("post_message", {
      interaction_token: "tok",
      content: "secret",
      ephemeral: true,
    });
    const [route, opts] = rest.post.mock.calls[0];
    expect(route).toBe(Routes.webhook(APP, "tok"));
    expect(opts).toMatchObject({ auth: false, body: { content: "secret", flags: 64 } });
  });

  it("edit_message via interaction token edits @original", async () => {
    rest.patch.mockResolvedValue({});
    const res = await handleAction("edit_message", { interaction_token: "tok", content: "x" });
    expect(rest.patch).toHaveBeenCalledWith(Routes.webhookMessage(APP, "tok", "@original"), {
      body: { content: "x", embeds: undefined, components: undefined },
      auth: false,
    });
    expect(res.body).toEqual({ ok: true });
  });

  it("delete_message and reactions hit the right routes", async () => {
    rest.delete.mockResolvedValue({});
    rest.put.mockResolvedValue({});
    await handleAction("delete_message", { target_id: "c", message_id: "m" });
    expect(rest.delete).toHaveBeenCalledWith(Routes.channelMessage("c", "m"));

    await handleAction("add_reaction", { channel_id: "c", message_id: "m", emoji: "%F0%9F%91%80" });
    expect(rest.put).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("c", "m", "%F0%9F%91%80")
    );
  });

  it("rejects an unknown op", async () => {
    const res = await handleAction("teleport", {});
    expect(res.status).toBe(400);
  });

  it("connect_guild stores the project key against the region host", async () => {
    const res = await handleAction("connect_guild", {
      guild_id: "g-connect",
      region: "eu",
      project_api_key: "phc_test",
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const cfg = readGuildConfig("g-connect");
    expect(cfg?.posthogApiKey).toBe("phc_test");
    expect(cfg?.posthogHost).toBe("https://eu.i.posthog.com");
  });

  it("connect_guild with no key disconnects the guild", async () => {
    await handleAction("connect_guild", {
      guild_id: "g-dc",
      region: "us",
      project_api_key: "phc_x",
    });
    await handleAction("connect_guild", { guild_id: "g-dc" });
    expect(readGuildConfig("g-dc")?.posthogApiKey ?? null).toBeNull();
  });

  it("connect_guild requires a guild_id", async () => {
    const res = await handleAction("connect_guild", { project_api_key: "phc_x" });
    expect(res.status).toBe(400);
  });

  it("watch_thread / unwatch_thread register and clear a thread", async () => {
    const watch = await handleAction("watch_thread", { guild_id: "g-wt", thread_id: "th1" });
    expect(watch).toEqual({ status: 200, body: { ok: true } });
    expect(isWatchedThread("g-wt", "th1")).toBe(true);

    await handleAction("unwatch_thread", { guild_id: "g-wt", thread_id: "th1" });
    expect(isWatchedThread("g-wt", "th1")).toBe(false);
  });

  it("watch_thread requires guild_id and thread_id", async () => {
    expect((await handleAction("watch_thread", { guild_id: "g" })).status).toBe(400);
    expect((await handleAction("watch_thread", { thread_id: "t" })).status).toBe(400);
  });
});

describe("actions HTTP server", () => {
  let server: ReturnType<typeof createActionsServer>;
  let base: string;

  beforeEach(async () => {
    server = createActionsServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => server.close());

  const auth = { Authorization: "Bearer test-secret" };

  it("401s without a valid bearer", async () => {
    const res = await fetch(`${base}/actions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("400s on invalid JSON", async () => {
    const res = await fetch(`${base}/actions`, { method: "POST", headers: auth, body: "not json" });
    expect(res.status).toBe(400);
  });

  it("dispatches an authenticated op", async () => {
    rest.post.mockResolvedValue({ id: "m9" });
    const res = await fetch(`${base}/actions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ op: "post_message", target_id: "c", content: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message_id: "m9" });
    expect(rest.post).toHaveBeenCalledTimes(1);
  });

  it("serves /health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
});

describe("ticket_reply", () => {
  it("posts a team reply into the ticket's linked Discord thread", async () => {
    const { linkTicket } = await import("@/db.js");
    linkTicket("g-tr", "thread-tr", "uuid-tr", 42, 1);
    rest.post.mockResolvedValue({ id: "m9" });

    const res = await handleAction("ticket_reply", {
      ticket_id: "uuid-tr",
      message: "We shipped a fix.",
    });

    expect(rest.post).toHaveBeenCalledWith(Routes.channelMessages("thread-tr"), {
      body: { content: "We shipped a fix." },
      auth: true,
    });
    expect(res).toEqual({
      status: 200,
      body: { ok: true, thread_id: "thread-tr", message_id: "m9" },
    });
  });

  it("resolves the thread by numeric ticket number too", async () => {
    const { linkTicket } = await import("@/db.js");
    linkTicket("g-tn", "thread-tn", "uuid-tn", 77, 1);
    rest.post.mockResolvedValue({ id: "m10" });

    const res = await handleAction("ticket_reply", { ticket_id: "77", message: "hi" });

    expect(rest.post).toHaveBeenCalledWith(Routes.channelMessages("thread-tn"), {
      body: { content: "hi" },
      auth: true,
    });
    expect(res.status).toBe(200);
  });

  it("skips (200) a ticket with no Discord thread — email/widget tickets", async () => {
    const res = await handleAction("ticket_reply", {
      ticket_id: "uuid-unknown",
      message: "hello",
    });
    expect(rest.post).not.toHaveBeenCalled();
    expect(res).toEqual({
      status: 200,
      body: { ok: true, skipped: "no linked thread" },
    });
  });

  it("truncates to Discord's 2000-character limit", async () => {
    const { linkTicket } = await import("@/db.js");
    linkTicket("g-long", "thread-long", "uuid-long", 78, 1);
    rest.post.mockResolvedValue({ id: "m11" });

    await handleAction("ticket_reply", {
      ticket_id: "uuid-long",
      message: "x".repeat(2500),
    });

    const body = rest.post.mock.calls[0][1].body as { content: string };
    expect(body.content).toHaveLength(2000);
  });

  it("rejects a call without ticket_id or message", async () => {
    expect(await handleAction("ticket_reply", { message: "m" })).toEqual({
      status: 400,
      body: { error: "missing ticket_id or message" },
    });
    expect(await handleAction("ticket_reply", { ticket_id: "u" })).toEqual({
      status: 400,
      body: { error: "missing ticket_id or message" },
    });
  });
});

describe("ticket_status", () => {
  const FORUM = "forum-1";
  // Status tags plus one unrelated tag that must survive a status change.
  const TAGS = [
    { id: "t-new", name: "New" },
    { id: "t-open", name: "Open" },
    { id: "t-pending", name: "Pending" },
    { id: "t-hold", name: "On hold" },
    { id: "t-resolved", name: "Resolved" },
    { id: "t-macos", name: "macOS" },
  ];

  /** Mock the two GETs the op makes: the thread, then its parent forum. */
  function mockChannels(appliedTags: string[], tags = TAGS, parentId: string | null = FORUM) {
    rest.get.mockImplementation(async (route: string) =>
      route.includes(FORUM) ? { available_tags: tags } : { parent_id: parentId, applied_tags: appliedTags }
    );
  }

  it("swaps the status tag and keeps unrelated tags", async () => {
    const { linkTicket } = await import("@/db.js");
    linkTicket("g-st", "thread-st", "uuid-st", 50, 1);
    mockChannels(["t-new", "t-macos"]);
    rest.patch.mockResolvedValue({});

    const res = await handleAction("ticket_status", {
      ticket_id: "uuid-st",
      status: "open",
      previous_status: "new",
    });

    // The old status tag is dropped, macOS stays, Open is added.
    expect(rest.patch).toHaveBeenCalledWith(Routes.channel("thread-st"), {
      body: { applied_tags: ["t-macos", "t-open"] },
    });
    // Status no longer shows up as a message in the thread.
    expect(rest.post).not.toHaveBeenCalled();
    expect(res).toEqual({
      status: 200,
      body: { ok: true, thread_id: "thread-st", applied_tag: "Open", archived: false },
    });
  });

  it("tags Resolved and archives in one patch", async () => {
    const { linkTicket } = await import("@/db.js");
    linkTicket("g-rs", "thread-rs", "uuid-rs", 51, 1);
    mockChannels(["t-open"]);
    rest.patch.mockResolvedValue({});

    const res = await handleAction("ticket_status", {
      ticket_id: "uuid-rs",
      status: "resolved",
    });

    // One call: archiving first would make the tag write fail on a closed thread.
    expect(rest.patch).toHaveBeenCalledTimes(1);
    expect(rest.patch).toHaveBeenCalledWith(Routes.channel("thread-rs"), {
      body: { applied_tags: ["t-resolved"], archived: true },
    });
    expect(res.body).toMatchObject({ applied_tag: "Resolved", archived: true });
  });

  it("matches tag names loosely (on_hold → 'On hold')", async () => {
    const { linkTicket } = await import("@/db.js");
    linkTicket("g-oh", "thread-oh", "uuid-oh", 53, 1);
    mockChannels([]);
    rest.patch.mockResolvedValue({});

    await handleAction("ticket_status", { ticket_id: "uuid-oh", status: "on_hold" });

    expect(rest.patch).toHaveBeenCalledWith(Routes.channel("thread-oh"), {
      body: { applied_tags: ["t-hold"] },
    });
  });

  it("leaves tags alone when the forum has no matching tag", async () => {
    const { linkTicket } = await import("@/db.js");
    linkTicket("g-nt", "thread-nt", "uuid-nt", 54, 1);
    mockChannels(["t-macos"], [{ id: "t-macos", name: "macOS" }]);

    const res = await handleAction("ticket_status", { ticket_id: "uuid-nt", status: "open" });

    expect(rest.patch).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ applied_tag: null, archived: false });
  });

  it("does nothing for an unknown status", async () => {
    const { linkTicket } = await import("@/db.js");
    linkTicket("g-uk", "thread-uk", "uuid-uk", 52, 1);

    const res = await handleAction("ticket_status", {
      ticket_id: "uuid-uk",
      status: "escalated",
    });

    // No mapping, so the post's existing tag is never cleared.
    expect(rest.get).not.toHaveBeenCalled();
    expect(rest.patch).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ applied_tag: null, archived: false });
  });

  it("still archives a resolved ticket in a non-forum thread", async () => {
    const { linkTicket } = await import("@/db.js");
    linkTicket("g-nf", "thread-nf", "uuid-nf", 55, 1);
    mockChannels([], TAGS, null); // no parent forum
    rest.patch.mockResolvedValue({});

    await handleAction("ticket_status", { ticket_id: "uuid-nf", status: "resolved" });

    expect(rest.patch).toHaveBeenCalledWith(Routes.channel("thread-nf"), {
      body: { archived: true },
    });
  });

  it("skips (200) a ticket with no Discord thread", async () => {
    const res = await handleAction("ticket_status", {
      ticket_id: "uuid-none",
      status: "resolved",
    });
    expect(rest.patch).not.toHaveBeenCalled();
    expect(res).toEqual({
      status: 200,
      body: { ok: true, skipped: "no linked thread" },
    });
  });

  it("rejects a call without ticket_id or status", async () => {
    expect(await handleAction("ticket_status", { status: "open" })).toEqual({
      status: 400,
      body: { error: "missing ticket_id or status" },
    });
  });
});

describe("deleted threads", () => {
  const unknownChannel = () =>
    new DiscordAPIError(
      { message: "Unknown Channel", code: 10003 },
      10003,
      404,
      "GET",
      "https://discord.com/api/v10/channels/x",
      { body: {} }
    );

  it("ticket_status unlinks the ticket and skips when the thread is gone", async () => {
    const { linkTicket, getTicketForThread } = await import("@/db.js");
    linkTicket("g-del", "thread-del", "uuid-del", 60, 1);
    rest.get.mockRejectedValue(unknownChannel());

    const res = await handleAction("ticket_status", {
      ticket_id: "uuid-del",
      status: "open",
    });

    // A 500 here would make the PostHog workflow retry against a dead thread.
    expect(res).toEqual({
      status: 200,
      body: { ok: true, skipped: "thread deleted" },
    });
    expect(getTicketForThread("thread-del")).toBeNull();
  });

  it("ticket_reply unlinks the ticket and skips when the thread is gone", async () => {
    const { linkTicket, getTicketForThread } = await import("@/db.js");
    linkTicket("g-del2", "thread-del2", "uuid-del2", 61, 1);
    rest.post.mockRejectedValue(unknownChannel());

    const res = await handleAction("ticket_reply", {
      ticket_id: "uuid-del2",
      message: "hello",
    });

    expect(res).toEqual({
      status: 200,
      body: { ok: true, skipped: "thread deleted" },
    });
    expect(getTicketForThread("thread-del2")).toBeNull();
  });

  it("still surfaces other Discord errors", async () => {
    const { linkTicket } = await import("@/db.js");
    linkTicket("g-err", "thread-err", "uuid-err", 62, 1);
    rest.post.mockRejectedValue(
      new DiscordAPIError(
        { message: "Missing Permissions", code: 50013 },
        50013,
        403,
        "POST",
        "https://discord.com/api/v10/channels/x/messages",
        { body: {} }
      )
    );

    await expect(
      handleAction("ticket_reply", { ticket_id: "uuid-err", message: "hi" })
    ).rejects.toThrow("Missing Permissions");
  });
});
