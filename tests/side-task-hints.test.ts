import OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
/**
 * The SDK-touching half of the client module, replaced. Partial rather than whole: the rest of
 * it is pure — `endpointKey` is what every cache in this package agrees an endpoint is — and a
 * blanket mock takes those out from under the modules under test too.
 */
vi.mock("../src/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.ts")>()),
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
const sentHints = (nth: number) => "chat_template_kwargs" in create.mock.calls[nth][0];

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
/** The opposite refusal: the model reasons, it just does not offer the `none` a side task wants. */
const NO_EFFORT_NONE = apiError(
  400,
  "Unsupported value: 'reasoning_effort' does not support 'none' with this model. " +
    "Supported values are: 'minimal', 'low', 'medium', and 'high'.",
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
    expect(notices).toEqual([
      "m rejected a request carrying the no-thinking hints; retrying without them",
    ]);

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

  it("does not latch on a 400 that dropping them did not fix", async () => {
    // A context overflow is a 400 `negotiate` does not recognise, as the hints are. Latching
    // before the retry had shown anything cost every later side task on the model its hints.
    const overflow = apiError(400, "This model's maximum context length is 4096 tokens");
    create.mockRejectedValueOnce(overflow).mockRejectedValueOnce(overflow);
    await expect(call(endpoint("http://small/v1"))).rejects.toThrow("maximum context length");
    expect(create).toHaveBeenCalledTimes(2);

    create.mockResolvedValue(reply);
    await call(endpoint("http://small/v1"));
    expect(sentHints(2)).toBe(true);
    expect(body(2).reasoning_effort).toBe("none");
  });

  it("keeps sending the effort to a model that refused only the template kwargs", async () => {
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValue(reply);
    await call(endpoint("http://vllm/v1"));
    expect(body(1)).not.toHaveProperty("reasoning_effort");

    await call(endpoint("http://vllm/v1"));
    expect(sentHints(2)).toBe(false);
    expect(body(2).reasoning_effort).toBe("none");
    const supports = capabilitiesFor("http://vllm/v1");
    expect(modelCapabilitiesFor(supports, "m").reasoningEffort).toBe(true);
  });

  it("latches the effort when it is all that is left to drop", async () => {
    // Both refused in wordings `negotiate` does not know: the first call blames the kwargs, the
    // next is left with only the effort, and after that neither goes out.
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValueOnce(reply);
    await call(endpoint("http://odd/v1"));
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValueOnce(reply);
    await call(endpoint("http://odd/v1"));
    expect(body(2).reasoning_effort).toBe("none");
    expect(body(3)).not.toHaveProperty("reasoning_effort");

    create.mockResolvedValue(reply);
    await call(endpoint("http://odd/v1"));
    expect(create).toHaveBeenCalledTimes(5);
    expect(body(4)).not.toHaveProperty("reasoning_effort");
    expect(sentHints(4)).toBe(false);
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
      "picky-model rejected a request carrying the no-thinking hints; retrying without them",
      "other-model rejected a request carrying the no-thinking hints; retrying without them",
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

  it("asks for the cheapest effort the model offers when it will not take none", async () => {
    // What sent a side task to its own fallback path and then latched the effort off for good:
    // the request failed outright, and every later call on the model ran with nothing said about
    // deliberating — on the models most inclined to deliberate.
    const notices: string[] = [];
    create.mockRejectedValueOnce(NO_EFFORT_NONE).mockResolvedValue(reply);
    await expect(
      ask(endpoint("https://api.openai.com/v1"), "gpt-5", "system", "user", {
        onNotice: (message) => notices.push(message),
      }),
    ).resolves.toBe("ok");
    expect(create).toHaveBeenCalledTimes(2);
    expect(body(0).reasoning_effort).toBe("none");
    expect(body(1).reasoning_effort).toBe("minimal");
    expect(notices).toEqual(["gpt-5 does not reason at none; retrying at minimal"]);
    // And the next call starts where this one left off rather than paying for it again.
    create.mockReset();
    create.mockResolvedValue(reply);
    await call(endpoint("https://api.openai.com/v1"), "gpt-5");
    expect(create).toHaveBeenCalledTimes(1);
    expect(body(0).reasoning_effort).toBe("minimal");
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
