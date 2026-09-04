import { Events } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureForGuild, toPersonLike } = vi.hoisted(() => ({
  captureForGuild: vi.fn(),
  toPersonLike: vi.fn((u: { id: string }) => ({ personLikeFor: u.id })),
}));
vi.mock("@/capture.js", () => ({ captureForGuild, toPersonLike }));

const { register } = await import("@/events/threads.js");

/** The owner the handler fetches; null models a fetch failure. */
let fetchedOwner: unknown = { id: "u1", username: "poster", globalName: "Poster" };
const usersFetch = vi.fn(async () => {
  if (fetchedOwner === null) throw new Error("unknown user");
  return fetchedOwner;
});

function client() {
  const handlers = new Map<string, (...a: unknown[]) => Promise<void> | void>();
  register({ on: (e: string, cb: never) => handlers.set(e, cb) } as never);
  // The handler is async, so callers must await it before asserting.
  return { fire: (e: string, ...a: unknown[]) => handlers.get(e)?.(...a) };
}

function thread(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "help",
    ownerId: "u1",
    parentId: "c1",
    parent: { name: "general" },
    guild: { id: "g1", name: "G" },
    client: { users: { fetch: usersFetch } },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchedOwner = { id: "u1", username: "poster", globalName: "Poster" };
});

describe("ThreadCreate", () => {
  it("captures thread_created for a newly created thread", async () => {
    await client().fire(Events.ThreadCreate, thread(), true);
    expect(captureForGuild.mock.calls[0][0]).toMatchObject({
      event: "thread_created",
      distinctId: "u1",
      properties: {
        thread_id: "t1",
        thread_name: "help",
        parent_channel_id: "c1",
        parent_channel_name: "general",
      },
    });
  });

  it("attaches the fetched owner as the actor, so the person gets a name", async () => {
    await client().fire(Events.ThreadCreate, thread(), true);
    expect(usersFetch).toHaveBeenCalledWith("u1");
    expect(captureForGuild.mock.calls[0][0].actor).toEqual({ personLikeFor: "u1" });
  });

  it("still captures the event when the owner can't be fetched", async () => {
    fetchedOwner = null;
    await client().fire(Events.ThreadCreate, thread(), true);
    // The event matters more than the person properties it would have carried.
    expect(captureForGuild).toHaveBeenCalledTimes(1);
    expect(captureForGuild.mock.calls[0][0].actor).toBeUndefined();
  });

  it("ignores threads the bot merely gained access to", async () => {
    await client().fire(Events.ThreadCreate, thread(), false);
    expect(captureForGuild).not.toHaveBeenCalled();
  });

  it("skips threads with no owner to attribute", async () => {
    await client().fire(Events.ThreadCreate, thread({ ownerId: null }), true);
    expect(captureForGuild).not.toHaveBeenCalled();
    expect(usersFetch).not.toHaveBeenCalled();
  });
});
