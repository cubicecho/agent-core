import OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("../src/client.ts", () => ({
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { ask, resetHints } = await import("../src/side-task.ts");
const { modelCapabilitiesFor, capabilitiesFor, resetCapabilities } = await import(
  "../src/capabilities.ts"
);

const reply = { choices: [{ message: { content: "ok" } }] };
const endpoint = (baseUrl: string) => ({ baseUrl, apiKey: "", requestTimeoutSeconds: 60 });
const call = (config: ReturnType<typeof endpoint>, model = "m") =>
  ask(config, model, "system", "user");
/** Whether the hints rode along on the nth call. */
const sentHints = (nth: number) => "reasoning_effort" in create.mock.calls[nth][0];

const apiError = (status: number, message = "rejected") =>
  new OpenAI.APIError(status, { error: { message } }, message, undefined);

/** The three the model refuses by name, as OpenAI words them. */
const WANTS_COMPLETION_LIMIT = apiError(
  400,
  "Unsupported parameter: 'max_tokens' is not supported with this model. " +
    "Use 'max_completion_tokens' instead.",
);
const OWN_TEMPERATURE = apiError(
  400,
  "Unsupported value: 'temperature' does not support 0.3 with this model. " +
    "Only the default (1) is supported.",
);
const NO_EFFORT = apiError(
  400,
  "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
);

/** What the nth call actually put in the body. */
const body = (nth: number) => create.mock.calls[nth][0] as Record<string, unknown>;

describe("no-thinking hints", () => {
  // The latch outlives a test as surely as the mock does. Without this the suite only passed
  // because every test had been handed a hostname of its own.
  beforeEach(() => {
    create.mockReset();
    resetHints();
    // The latch `negotiate` keeps outlives a test the same way this module's does, and `ask`
    // now reads both.
    resetCapabilities();
  });

  it("reports the downgrade to a caller who asked, and to nobody who did not", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notices: string[] = [];
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValue(reply);
    await ask(endpoint("http://picky/v1"), "m", "system", "user", {
      onNotice: (message) => notices.push(message),
    });
    expect(notices).toEqual(["m rejected the no-thinking hints; retrying without them"]);

    // A library that writes to the console has decided for its consumer where operator text
    // goes. The retry still happens; it just says so through the seam or not at all.
    resetHints();
    create.mockReset();
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValue(reply);
    await call(endpoint("http://picky/v1"));
    expect(create).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stops offering them to a server that answered 4xx", async () => {
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValue(reply);
    await call(endpoint("http://picky/v1"));
    expect(sentHints(0)).toBe(true);
    expect(sentHints(1)).toBe(false);

    await call(endpoint("http://picky/v1"));
    expect(create).toHaveBeenCalledTimes(3);
    expect(sentHints(2)).toBe(false);
  });

  it("keeps offering them after a failure that says nothing about the request", async () => {
    // A timeout, an aborted call or a 500 is the server failing to answer, not refusing the
    // fields — latching on one of those cost every later side task its whole budget.
    create.mockRejectedValueOnce(apiError(503));
    await expect(call(endpoint("http://flaky/v1"))).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);

    create.mockResolvedValue(reply);
    await call(endpoint("http://flaky/v1"));
    expect(sentHints(1)).toBe(true);
  });

  it("keeps one endpoint's refusal off another's calls", async () => {
    create.mockRejectedValueOnce(apiError(422)).mockResolvedValue(reply);
    await call(endpoint("http://local/v1"));

    await call(endpoint("http://cloud/v1"));
    expect(sentHints(2)).toBe(true);
  });

  it("keeps one model's refusal off another model on the same host", async () => {
    // One base URL is routinely many models — a router, or vLLM serving several. Whether the
    // hints are understood belongs to the model, not to the route.
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValue(reply);
    await call(endpoint("http://router/v1"), "picky-model");
    expect(sentHints(1)).toBe(false);

    await call(endpoint("http://router/v1"), "other-model");
    expect(sentHints(2)).toBe(true);
  });

  it("names the model in the notice, so two on one host are told apart", async () => {
    // The latch is on the (endpoint, model) pair and this line is the only announcement that it
    // caught. Opening with "server" made every model behind one route say the same sentence.
    const notices: string[] = [];
    const watched = (model: string) =>
      ask(endpoint("http://router/v1"), model, "system", "user", {
        onNotice: (message) => notices.push(message),
      });
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValue(reply);
    await watched("picky-model");
    create.mockReset();
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValue(reply);
    await watched("other-model");

    expect(notices).toEqual([
      "picky-model rejected the no-thinking hints; retrying without them",
      "other-model rejected the no-thinking hints; retrying without them",
    ]);
  });

  it("does not latch on a rate limit, or answer one by sending it again", async () => {
    // 429 is a 4xx that says nothing about the fields, and `isTransient` accepts it. Retrying
    // it here doubled the request rate against a server that had just asked for less.
    create.mockRejectedValueOnce(apiError(429));
    await expect(call(endpoint("http://busy/v1"))).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);

    create.mockResolvedValue(reply);
    await call(endpoint("http://busy/v1"));
    expect(sentHints(1)).toBe(true);
  });

  it("does not latch on a bad key or a missing model", async () => {
    for (const status of [401, 404]) {
      resetHints();
      create.mockReset();
      create.mockRejectedValueOnce(apiError(status));
      await expect(call(endpoint("http://auth/v1"))).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it("does not return a scratchpad that ran out of budget as the answer", async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: "<think>weighing it up and then the budget ran" } }],
    });
    expect(await call(endpoint("http://reasoner/v1"))).toBe("");
  });

  it("falls back to reasoning_content when the content is all scratchpad", async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: "", reasoning_content: "deliberation — the answer" } }],
    });
    expect(await call(endpoint("http://split/v1"))).toBe("deliberation — the answer");
  });
});

describe("what the model refuses", () => {
  beforeEach(() => {
    create.mockReset();
    resetHints();
    resetCapabilities();
  });

  it("spells the ceiling the way the model wants it", async () => {
    // Every side task against an OpenAI reasoning model used to fail here: the hint retry is
    // not what a `max_tokens` refusal is about, so the same field went back out and came back
    // the same way, and `tryAsk` turned that into a session with no title.
    create.mockRejectedValueOnce(WANTS_COMPLETION_LIMIT).mockResolvedValue(reply);
    await expect(call(endpoint("https://api.openai.com/v1"), "o3")).resolves.toBe("ok");
    expect(body(0).max_tokens).toBe(512);
    expect(body(1).max_completion_tokens).toBe(512);
    expect(body(1)).not.toHaveProperty("max_tokens");
    // And the run on the same model does not have to find this out for itself.
    const supports = capabilitiesFor("https://api.openai.com/v1");
    expect(modelCapabilitiesFor(supports, "o3").legacyTokenLimit).toBe(false);
  });

  it("lets the model keep the temperature it was built with", async () => {
    create.mockRejectedValueOnce(OWN_TEMPERATURE).mockResolvedValue(reply);
    await expect(call(endpoint("https://api.openai.com/v1"), "o3")).resolves.toBe("ok");
    expect(body(0).temperature).toBe(0.3);
    expect(body(1)).not.toHaveProperty("temperature");
  });

  it("drops the effort without dropping the other spelling of the same hint", async () => {
    // The two used to go out and be given up on as a bundle, so a model that had never heard of
    // `reasoning_effort` also stopped being told, in the spelling it does read, not to think.
    create.mockRejectedValueOnce(NO_EFFORT).mockResolvedValue(reply);
    await expect(call(endpoint("http://vllm/v1"), "qwen")).resolves.toBe("ok");
    expect(create).toHaveBeenCalledTimes(2);
    expect(body(1)).not.toHaveProperty("reasoning_effort");
    expect(body(1).chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("does not spend a second call on what it was told the first time", async () => {
    create.mockRejectedValueOnce(WANTS_COMPLETION_LIMIT).mockResolvedValue(reply);
    await call(endpoint("https://api.openai.com/v1"), "o3");
    create.mockReset();
    create.mockResolvedValue(reply);
    await call(endpoint("https://api.openai.com/v1"), "o3");
    expect(create).toHaveBeenCalledTimes(1);
    expect(body(0).max_completion_tokens).toBe(512);
  });
});
