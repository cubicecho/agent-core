import { beforeEach, describe, expect, it, vi } from "vitest";
import { capabilitiesFor, negotiate, resetCapabilities } from "../src/capabilities.ts";

/** How each server words the refusal, near enough. */
const NO_GRAMMAR = new Error("Failed to initialize samplers: failed to parse grammar");
const NO_USAGE = new Error("400 Unrecognized request argument supplied: stream_options");

/** A send that refuses in order and then answers, recording what it was asked for each time. */
const serverThatRefuses = (...refusals: Error[]) => {
  const asked: { strictSchemas: boolean; usageInStream: boolean }[] = [];
  const send = vi.fn(async (supports: { strictSchemas: boolean; usageInStream: boolean }) => {
    asked.push({ ...supports });
    const refusal = refusals.shift();
    if (refusal) throw refusal;
    return "answered";
  });
  return { send, asked };
};

beforeEach(() => resetCapabilities());

describe("capabilitiesFor", () => {
  it("starts optimistic and hands back the same memory each time", () => {
    const supports = capabilitiesFor("http://local/v1");
    expect(supports).toEqual({ strictSchemas: true, usageInStream: true });
    supports.strictSchemas = false;
    expect(capabilitiesFor("http://local/v1").strictSchemas).toBe(false);
  });

  it("keeps one endpoint's refusal off another's requests", () => {
    // The globals this replaces latched for the whole process: one llama.cpp box that could not
    // compile a grammar then stripped pattern/format from every request to the cloud endpoint
    // beside it, for the life of the process, and nothing ever said so.
    capabilitiesFor("http://local/v1").strictSchemas = false;
    expect(capabilitiesFor("https://api.openai.com/v1").strictSchemas).toBe(true);
  });

  it("forgets everything on reset", () => {
    capabilitiesFor("http://local/v1").usageInStream = false;
    resetCapabilities();
    expect(capabilitiesFor("http://local/v1").usageInStream).toBe(true);
  });
});

describe("negotiate", () => {
  it("sends once against an endpoint with nothing to say about the request", async () => {
    const { send } = serverThatRefuses();
    await expect(negotiate(capabilitiesFor("http://ok/v1"), send)).resolves.toBe("answered");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("answers both refusals in one call, not one per run", async () => {
    // The drift this exists to end: a server that has heard of neither `stream_options` nor a
    // grammar keyword complains about them one at a time, and answering only the first left the
    // second to fail the request — so the first run against such an endpoint was spent
    // discovering what the second one starts knowing.
    const supports = capabilitiesFor("http://old-llama/v1");
    const { send, asked } = serverThatRefuses(NO_USAGE, NO_GRAMMAR);
    await expect(negotiate(supports, send)).resolves.toBe("answered");
    expect(asked).toEqual([
      { strictSchemas: true, usageInStream: true },
      { strictSchemas: true, usageInStream: false },
      { strictSchemas: false, usageInStream: false },
    ]);
    expect(supports).toEqual({ strictSchemas: false, usageInStream: false });
  });

  it("answers them in the other order too", async () => {
    const supports = capabilitiesFor("http://old-llama/v1");
    const { send } = serverThatRefuses(NO_GRAMMAR, NO_USAGE);
    await expect(negotiate(supports, send)).resolves.toBe("answered");
    expect(supports).toEqual({ strictSchemas: false, usageInStream: false });
  });

  it("opens with what the endpoint already refused", async () => {
    const supports = capabilitiesFor("http://old-llama/v1");
    await negotiate(supports, serverThatRefuses(NO_GRAMMAR).send);

    const { send, asked } = serverThatRefuses();
    await negotiate(supports, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(asked[0]?.strictSchemas).toBe(false);
  });

  it("passes on a refusal that is not one of ours", async () => {
    const { send } = serverThatRefuses(new Error("model not found"));
    await expect(negotiate(capabilitiesFor("http://ok/v1"), send)).rejects.toThrow(
      "model not found",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than looping on a server that will not stop complaining", async () => {
    // Termination is one pass per capability: each either latches one off for good or rethrows.
    const { send } = serverThatRefuses(NO_GRAMMAR, NO_GRAMMAR);
    await expect(negotiate(capabilitiesFor("http://stuck/v1"), send)).rejects.toThrow("grammar");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never re-sends once the server has started answering", async () => {
    // The tokens are already out and on their way to whoever is watching; a second attempt
    // would say everything twice.
    const produced = { any: false };
    const send = vi.fn(async () => {
      produced.any = true;
      throw NO_GRAMMAR;
    });
    await expect(negotiate(capabilitiesFor("http://ok/v1"), send, { produced })).rejects.toThrow(
      "grammar",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(capabilitiesFor("http://ok/v1").strictSchemas).toBe(true);
  });

  it("says what it gave up on", async () => {
    const notices: string[] = [];
    const { send } = serverThatRefuses(NO_USAGE, NO_GRAMMAR);
    await negotiate(capabilitiesFor("http://old-llama/v1"), send, {
      onNotice: (message) => notices.push(message),
    });
    expect(notices).toEqual([
      "server rejected stream_options; token counts unavailable",
      "server could not build a grammar; retrying without pattern/format",
    ]);
  });
});
