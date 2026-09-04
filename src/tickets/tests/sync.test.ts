import { beforeEach, describe, expect, it, vi } from "vitest";

const { client } = vi.hoisted(() => ({
  client: {
    createTicket: vi.fn(),
    replyToTicket: vi.fn(),
    ticketsEnabled: vi.fn(() => true),
  },
}));
vi.mock("@/tickets/client.js", () => client);

const { addReplyToTicket, openTicketForPost } = await import("@/tickets/sync.js");
const { getTicketForThread, linkTicket } = await import("@/db.js"); // real in-memory SQLite

const AUTHOR = { id: "3210", username: "maciej", globalName: "Maciej" };

let counter = 0;
/** Unique ids per test — the in-memory DB is shared across the file. */
function ids(): { guildId: string; threadId: string } {
  counter += 1;
  return { guildId: `g-${counter}`, threadId: `t-${counter}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.ticketsEnabled.mockReturnValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("openTicketForPost", () => {
  it("creates a ticket and links it to the thread", async () => {
    const { guildId, threadId } = ids();
    client.createTicket.mockResolvedValue({ id: "uuid-1", ticketNumber: 25 });

    await openTicketForPost({
      guildId,
      threadId,
      title: "Crash on launch",
      content: "Steps to reproduce…",
      tags: ["bug", "macos"],
      author: AUTHOR,
    });

    expect(client.createTicket).toHaveBeenCalledTimes(1);
    const arg = client.createTicket.mock.calls[0][0];
    expect(arg.title).toBe("Crash on launch");
    expect(arg.message).toContain("Steps to reproduce…");
    expect(arg.message).toContain("Tags: bug, macos");
    // The reporter is named both in the body and as the ticket's author trait.
    expect(arg.message).toContain("Maciej (@maciej)");
    expect(arg.authorName).toBe("Maciej (@maciej)");
    expect(arg.discordUserId).toBe("3210");

    expect(getTicketForThread(threadId)).toMatchObject({
      guildId,
      ticketId: "uuid-1",
      ticketNumber: 25,
    });
  });

  it("omits the tag line when there are no tags", async () => {
    const { guildId, threadId } = ids();
    client.createTicket.mockResolvedValue({ id: "u", ticketNumber: 1 });
    await openTicketForPost({
      guildId,
      threadId,
      title: "t",
      content: "body",
      tags: [],
      author: AUTHOR,
    });
    expect(client.createTicket.mock.calls[0][0].message).not.toContain("Tags:");
  });

  it("is a no-op when the thread already has a ticket", async () => {
    const { guildId, threadId } = ids();
    linkTicket(guildId, threadId, "existing", 7, 1);

    await openTicketForPost({
      guildId,
      threadId,
      title: "t",
      content: "c",
      tags: [],
      author: AUTHOR,
    });

    expect(client.createTicket).not.toHaveBeenCalled();
    expect(getTicketForThread(threadId)?.ticketId).toBe("existing");
  });

  it("does nothing when the integration is disabled", async () => {
    const { guildId, threadId } = ids();
    client.ticketsEnabled.mockReturnValue(false);
    await openTicketForPost({
      guildId,
      threadId,
      title: "t",
      content: "c",
      tags: [],
      author: AUTHOR,
    });
    expect(client.createTicket).not.toHaveBeenCalled();
    expect(getTicketForThread(threadId)).toBeNull();
  });

  it("stores no link when ticket creation fails", async () => {
    const { guildId, threadId } = ids();
    client.createTicket.mockResolvedValue(null);
    await openTicketForPost({
      guildId,
      threadId,
      title: "t",
      content: "c",
      tags: [],
      author: AUTHOR,
    });
    expect(getTicketForThread(threadId)).toBeNull();
  });

  it("keeps the first link when a concurrent create wins the race", async () => {
    const { guildId, threadId } = ids();
    // Link the thread while createTicket is in flight, mimicking a duplicate
    // ThreadCreate: the second ticket must not repoint the thread.
    client.createTicket.mockImplementation(async () => {
      linkTicket(guildId, threadId, "first", 1, 1);
      return { id: "second", ticketNumber: 2 };
    });

    await openTicketForPost({
      guildId,
      threadId,
      title: "t",
      content: "c",
      tags: [],
      author: AUTHOR,
    });

    expect(getTicketForThread(threadId)?.ticketId).toBe("first");
  });
});

describe("addReplyToTicket", () => {
  it("posts the reply as an internal note on the linked ticket", async () => {
    const { guildId, threadId } = ids();
    linkTicket(guildId, threadId, "uuid-9", 9, 1);
    client.replyToTicket.mockResolvedValue(true);

    await addReplyToTicket({ threadId, content: "any update?", author: AUTHOR });

    expect(client.replyToTicket).toHaveBeenCalledWith({
      ticketId: "uuid-9",
      message: "Maciej (@maciej) in Discord:\n\nany update?",
      isPrivate: true,
    });
  });

  it("ignores a thread with no ticket", async () => {
    const { threadId } = ids();
    await addReplyToTicket({ threadId, content: "hi", author: AUTHOR });
    expect(client.replyToTicket).not.toHaveBeenCalled();
  });

  it("does nothing when the integration is disabled", async () => {
    const { guildId, threadId } = ids();
    linkTicket(guildId, threadId, "uuid-x", 1, 1);
    client.ticketsEnabled.mockReturnValue(false);
    await addReplyToTicket({ threadId, content: "hi", author: AUTHOR });
    expect(client.replyToTicket).not.toHaveBeenCalled();
  });
});
