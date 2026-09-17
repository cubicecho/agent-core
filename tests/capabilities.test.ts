import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Capabilities,
  capabilitiesFor,
  effortFor,
  expireCapabilities,
  type ModelCapabilities,
  modelCapabilitiesFor,
  negotiate,
  resetCapabilities,
} from "../src/capabilities.ts";
import type { Produced } from "../src/stream.ts";

/** How each server words the refusal, near enough. */
const NO_GRAMMAR = new Error("Failed to initialize samplers: failed to parse grammar");
const NO_USAGE = new Error("400 Unrecognized request argument supplied: stream_options");

/** The three that are about the model, as OpenAI words them. */
const NO_EFFORT = new Error(
  "400 Unsupported parameter: 'reasoning_effort' is not supported with this model.",
);
const WANTS_COMPLETION_LIMIT = new Error(
  "400 Unsupported parameter: 'max_tokens' is not supported with this model. " +
    "Use 'max_completion_tokens' instead.",
);
const OWN_TEMPERATURE = new Error(
  "400 Unsupported value: 'temperature' does not support 0.7 with this model. " +
    "Only the default (1) is supported.",
);
/** Not a refusal of the field at all — the number was too big, which is the caller's to see. */
const TOO_MANY_TOKENS = new Error(
  "400 max_tokens is too large: 200000. This model supports at most 16384 completion tokens.",
);

/** Not a refusal of the field either — the model reasons, it just does not offer this effort. */
const NO_SUCH_EFFORT = new Error(
  "400 Unsupported value: 'reasoning_effort' does not support 'none' with this model. " +
    "Supported values are: 'minimal', 'low', 'medium', and 'high'.",
);
/** A real field refusal that happens to be worded the way a value refusal usually is. */
const NO_EFFORT_FIELD = new Error("400 This model does not support reasoning_effort.");

// The temperature's own value refusals, which read almost exactly like the field refusal above
// it. `does not support` is in all three, which is why it cannot be the marker.

/** The caller typed 5. The field works; the number is theirs to see rejected. */
const TEMPERATURE_OUT_OF_RANGE = new Error(
  "400 Invalid value: 'temperature' does not support 5. Supported values are between 0 and 2.",
);

/** The same refusal in a server's plainer words, quoting nothing. */
const TEMPERATURE_TOO_HIGH = new Error("400 temperature does not support values above 2");

/** A refusal of another field that says the word in passing — the advice at the end is all. */
const ANOTHER_FIELD_REFUSED = new Error(
  "400 Unsupported value: 'top_p' does not support 3 with this model. Adjust temperature instead.",
);

/** The same, for a model: refuses in order, recording what each attempt was built with. */
const modelThatRefuses = (...refusals: Error[]) => {
  const asked: ModelCapabilities[] = [];
  const send = vi.fn(
    async (_supports: Capabilities, _produced: Produced, model: ModelCapabilities | undefined) => {
      // The sets are copied too: they are the fields a later refusal changes in place.
      if (model) {
        asked.push({
          ...model,
          refusedFields: new Set(model.refusedFields),
          refusedEfforts: new Set(model.refusedEfforts),
        });
      }
      const refusal = refusals.shift();
      if (refusal) throw refusal;
      return "answered";
    },
  );
  return { send, asked };
};

/** A send that refuses in order and then answers, recording what it was asked for each time. */
const serverThatRefuses = (...refusals: Error[]) => {
  const asked: { strictSchemas: boolean; usageInStream: boolean }[] = [];
  const send = vi.fn(async (supports: { strictSchemas: boolean; usageInStream: boolean }) => {
    // The two flags alone: what a `Capabilities` also carries is the per-model map, and these
    // assertions are about the endpoint's own.
    asked.push({ strictSchemas: supports.strictSchemas, usageInStream: supports.usageInStream });
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
    expect(supports).toEqual({
      strictSchemas: true,
      usageInStream: true,
      models: new Map(),
      since: expect.any(Number),
    });
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

  it("keeps two keys through one router apart", () => {
    // A gateway is free to send two keys to two different backends, and then what one of them
    // refused is not a fact about the other. Keyed on the URL alone, the first caller through
    // latched for everyone behind it — including the `models` map underneath, which is where two
    // keys on one host are most likely to reach different weights in the first place.
    const cheap = capabilitiesFor("https://router/v1", "sk-cheap");
    cheap.strictSchemas = false;
    modelCapabilitiesFor(cheap, "gpt-4o").reasoningEffort = false;

    const paid = capabilitiesFor("https://router/v1", "sk-paid");
    expect(paid.strictSchemas).toBe(true);
    expect(modelCapabilitiesFor(paid, "gpt-4o").reasoningEffort).toBe(true);
    expect(capabilitiesFor("https://router/v1", "sk-cheap").strictSchemas).toBe(false);
  });

  it("reads no key and an empty one as one endpoint", () => {
    // The same reading `getClient` gives them, so a caller that threads its key through and one
    // that leaves it out are not two memories of the same local server.
    capabilitiesFor("http://local/v1").usageInStream = false;
    expect(capabilitiesFor("http://local/v1", "").usageInStream).toBe(false);
    expect(capabilitiesFor("http://local/v1", undefined).usageInStream).toBe(false);
  });

  it("forgets everything on reset", () => {
    capabilitiesFor("http://local/v1").usageInStream = false;
    resetCapabilities();
    expect(capabilitiesFor("http://local/v1").usageInStream).toBe(true);
  });

  it("forgets one endpoint by name, and says whether it held anything", () => {
    // The upgrade case: one box behind the URL grew a feature, and the cloud endpoint beside it
    // is not implicated. A reset that could only clear everything made the caller re-learn the
    // other's refusals too, which is why nobody called it.
    capabilitiesFor("http://local/v1").strictSchemas = false;
    capabilitiesFor("https://api.openai.com/v1").usageInStream = false;

    expect(resetCapabilities({ baseUrl: "http://local/v1" })).toBe(true);
    expect(capabilitiesFor("http://local/v1").strictSchemas).toBe(true);
    expect(capabilitiesFor("https://api.openai.com/v1").usageInStream).toBe(false);
    expect(resetCapabilities({ baseUrl: "http://never-met/v1" })).toBe(false);
  });

  it("tells one key on a router from another when forgetting one", () => {
    capabilitiesFor("https://router/v1", "sk-cheap").strictSchemas = false;
    capabilitiesFor("https://router/v1", "sk-paid").strictSchemas = false;
    expect(resetCapabilities({ baseUrl: "https://router/v1", apiKey: "sk-cheap" })).toBe(true);
    expect(capabilitiesFor("https://router/v1", "sk-cheap").strictSchemas).toBe(true);
    expect(capabilitiesFor("https://router/v1", "sk-paid").strictSchemas).toBe(false);
  });
});

describe("expireCapabilities", () => {
  it("drops what is older than the age and leaves the rest alone", () => {
    const old = capabilitiesFor("http://local/v1");
    old.strictSchemas = false;
    old.since = Date.now() - 60 * 60_000;
    capabilitiesFor("https://api.openai.com/v1").usageInStream = false;

    expect(expireCapabilities(30 * 60_000)).toBe(1);
    expect(capabilitiesFor("http://local/v1").strictSchemas).toBe(true);
    expect(capabilitiesFor("https://api.openai.com/v1").usageInStream).toBe(false);
  });

  it("takes a clock, and drops everything at an age of zero", () => {
    const supports = capabilitiesFor("http://local/v1");
    supports.strictSchemas = false;
    expect(expireCapabilities(60_000, supports.since + 59_000)).toBe(0);
    expect(capabilitiesFor("http://local/v1").strictSchemas).toBe(false);
    expect(expireCapabilities(60_000, supports.since + 60_000)).toBe(1);
    expect(capabilitiesFor("http://local/v1").strictSchemas).toBe(true);
    expect(expireCapabilities(0)).toBe(1);
    expect(expireCapabilities(0)).toBe(0);
  });

  it("forgets what a model refused along with its endpoint", () => {
    // The model map hangs off the endpoint, so an endpoint that expires takes with it the
    // `max_completion_tokens` and `reasoning_effort` latches that are the expensive half.
    const supports = capabilitiesFor("http://local/v1");
    modelCapabilitiesFor(supports, "qwen").reasoningEffort = false;
    expireCapabilities(0);
    const fresh = capabilitiesFor("http://local/v1");
    expect(fresh).not.toBe(supports);
    expect(modelCapabilitiesFor(fresh, "qwen").reasoningEffort).toBe(true);
  });
});

describe("effortFor", () => {
  const model = () => modelCapabilitiesFor(capabilitiesFor("https://api.openai.com/v1"), "gpt-5");

  it("sends what was asked for until the model says otherwise", () => {
    expect(effortFor(undefined, "low")).toBe("low");
    expect(effortFor(model(), "low")).toBe("low");
  });

  it("sends nothing for an absent or off effort, or a model that cannot reason", () => {
    expect(effortFor(model(), "")).toBe("");
    expect(effortFor(model(), undefined)).toBe("");
    expect(effortFor(model(), "off")).toBe("");
    const refused = model();
    refused.reasoningEffort = false;
    expect(effortFor(refused, "low")).toBe("");
  });

  it("steps up to the cheapest rung the model has not refused", () => {
    const refused = model();
    refused.refusedEfforts.add("none");
    expect(effortFor(refused, "none")).toBe("minimal");
    refused.refusedEfforts.add("minimal");
    expect(effortFor(refused, "none")).toBe("low");
  });

  it("steps a value the model's published list leaves out, without it being refused first", () => {
    // Two readings of the same fact, and the list is the one that arrives whole: a model that
    // lists `low, medium, high` has said what it thinks of `minimal` without being asked.
    const refused = model();
    refused.supportedEfforts = ["low", "medium", "high"];
    expect(effortFor(refused, "minimal")).toBe("low");
    expect(effortFor(refused, "medium")).toBe("medium");
  });

  it("hands back what it was given when there is nowhere to step", () => {
    // The caller's own value goes out and is refused again, where guessing would either reason
    // less than was asked for or send a rung already known to fail.
    const refused = model();
    refused.refusedEfforts.add("high");
    expect(effortFor(refused, "high")).toBe("high");
    expect(effortFor(refused, "xhigh")).toBe("xhigh");
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
    expect(supports).toMatchObject({ strictSchemas: false, usageInStream: false });
  });

  it("answers them in the other order too", async () => {
    const supports = capabilitiesFor("http://old-llama/v1");
    const { send } = serverThatRefuses(NO_GRAMMAR, NO_USAGE);
    await expect(negotiate(supports, send)).resolves.toBe("answered");
    expect(supports).toMatchObject({ strictSchemas: false, usageInStream: false });
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

describe("modelCapabilitiesFor", () => {
  it("starts optimistic and hands back the same memory each time", () => {
    const supports = capabilitiesFor("https://api.openai.com/v1");
    const model = modelCapabilitiesFor(supports, "gpt-5");
    expect(model).toEqual({
      reasoningEffort: true,
      legacyTokenLimit: true,
      chosenTemperature: true,
      refusedFields: new Set(),
      structuredOutput: true,
      refusedEfforts: new Set(),
      assistantPrefill: true,
    });
    model.reasoningEffort = false;
    expect(modelCapabilitiesFor(supports, "gpt-5").reasoningEffort).toBe(false);
  });

  it("keeps one model's refusal off another model's requests", () => {
    // The whole reason this is a second level. One key reaches both, so a flag on the endpoint
    // would have the first turn on `gpt-4o` stop `gpt-5` ever being asked to reason again —
    // with the setting still reading `high` and nothing saying it had stopped.
    const supports = capabilitiesFor("https://api.openai.com/v1");
    modelCapabilitiesFor(supports, "gpt-4o").reasoningEffort = false;
    expect(modelCapabilitiesFor(supports, "gpt-5").reasoningEffort).toBe(true);
  });

  it("keeps one endpoint's answer off the same name at another endpoint", () => {
    // `gpt-4o` at OpenAI and `gpt-4o` behind a proxy need not be the same weights, and a proxy
    // is free to answer to a name it does not really serve.
    modelCapabilitiesFor(capabilitiesFor("https://api.openai.com/v1"), "gpt-4o").legacyTokenLimit =
      false;
    expect(
      modelCapabilitiesFor(capabilitiesFor("http://proxy/v1"), "gpt-4o").legacyTokenLimit,
    ).toBe(true);
  });

  it("forgets everything on reset", () => {
    modelCapabilitiesFor(capabilitiesFor("http://local/v1"), "m").chosenTemperature = false;
    resetCapabilities();
    expect(modelCapabilitiesFor(capabilitiesFor("http://local/v1"), "m").chosenTemperature).toBe(
      true,
    );
  });
});

describe("negotiate, for a model", () => {
  const openai = () => capabilitiesFor("https://api.openai.com/v1");

  it("stops asking a model that cannot reason for an effort", async () => {
    const supports = openai();
    const { send, asked } = modelThatRefuses(NO_EFFORT);
    await expect(negotiate(supports, send, { model: "gpt-4o" })).resolves.toBe("answered");
    expect(asked.map((model) => model.reasoningEffort)).toEqual([true, false]);
    expect(modelCapabilitiesFor(supports, "gpt-4o").reasoningEffort).toBe(false);
  });

  it("spells the ceiling the way the model asks for", async () => {
    const supports = openai();
    const { send } = modelThatRefuses(WANTS_COMPLETION_LIMIT);
    await expect(negotiate(supports, send, { model: "gpt-5" })).resolves.toBe("answered");
    expect(modelCapabilitiesFor(supports, "gpt-5").legacyTokenLimit).toBe(false);
  });

  it("passes on a ceiling that was simply too high", async () => {
    // A bare `max_tokens` complaint is how a server says the number was too large, and the
    // answer to that is not to send the same number under a different name — it is to put the
    // error in front of whoever typed it.
    const supports = openai();
    const { send } = modelThatRefuses(TOO_MANY_TOKENS);
    await expect(negotiate(supports, send, { model: "gpt-5" })).rejects.toThrow("too large");
    expect(send).toHaveBeenCalledTimes(1);
    expect(modelCapabilitiesFor(supports, "gpt-5").legacyTokenLimit).toBe(true);
  });

  it("steps a refused effort up to one the model lists, rather than giving up reasoning", async () => {
    // A model that answers this reasons perfectly well — it was handed a value off a list this
    // package does not know. Dropping the field succeeds at the model's own default effort, which
    // is neither what the caller asked for nor something it can see, and the drop would latch for
    // every later turn. The refusal names the floor, so the next request asks for it.
    const supports = openai();
    const notices: string[] = [];
    const { send } = modelThatRefuses(NO_SUCH_EFFORT);
    await expect(
      negotiate(supports, send, { model: "gpt-5", onNotice: (m) => notices.push(m) }),
    ).resolves.toBe("answered");
    expect(send).toHaveBeenCalledTimes(2);
    const refused = modelCapabilitiesFor(supports, "gpt-5");
    expect(refused.reasoningEffort).toBe(true);
    expect([...refused.refusedEfforts]).toEqual(["none"]);
    expect(refused.supportedEfforts).toEqual(["minimal", "low", "medium", "high"]);
    expect(effortFor(refused, "none")).toBe("minimal");
    expect(notices).toEqual(["gpt-5 does not reason at none; retrying at minimal"]);
  });

  it("walks the ladder a rung at a time when the refusal lists nothing", async () => {
    const supports = openai();
    const refuse = (value: string) =>
      new Error(`400 Unsupported value: 'reasoning_effort' does not support '${value}'.`);
    const { send } = modelThatRefuses(refuse("none"), refuse("minimal"));
    await expect(negotiate(supports, send, { model: "gpt-5" })).resolves.toBe("answered");
    const refused = modelCapabilitiesFor(supports, "gpt-5");
    expect([...refused.refusedEfforts]).toEqual(["none", "minimal"]);
    expect(refused.supportedEfforts).toBeUndefined();
    expect(effortFor(refused, "none")).toBe("low");
  });

  it("gives the refusal back when the ladder runs out, or the value is not on it", async () => {
    // Never a step *down*: answering a refused `xhigh` with `high` would quietly reason less than
    // whoever typed it asked for, where stepping up only costs tokens and says so in a notice.
    const supports = openai();
    const unplaceable = new Error(
      "400 Unsupported value: 'reasoning_effort' does not support 'xhigh' with this model.",
    );
    const { send } = modelThatRefuses(unplaceable);
    await expect(negotiate(supports, send, { model: "gpt-5" })).rejects.toThrow("xhigh");
    expect(send).toHaveBeenCalledTimes(1);

    const topOut = new Error(
      "400 Unsupported value: 'reasoning_effort' does not support 'high' with this model. " +
        "Supported values are: 'low', 'medium'.",
    );
    const { send: second } = modelThatRefuses(topOut);
    await expect(negotiate(supports, second, { model: "gpt-4o" })).rejects.toThrow("high");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops rather than re-sending when the refusal names an effort nobody sent", async () => {
    // A server that answers every request the same way would otherwise have `negotiate` re-send
    // for as long as it kept saying it, since the latch it makes is one it has already made.
    const supports = openai();
    const refused = modelCapabilitiesFor(supports, "gpt-5");
    refused.refusedEfforts.add("none");
    const { send } = modelThatRefuses(NO_SUCH_EFFORT, NO_SUCH_EFFORT, NO_SUCH_EFFORT);
    await expect(negotiate(supports, send, { model: "gpt-5" })).rejects.toThrow(
      "Unsupported value",
    );
    // One re-send for the list it had not heard, and then out: the second refusal latches nothing
    // new, so the error is the caller's rather than another lap.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("still latches a field refusal worded like a value one", async () => {
    // `does not support` is how a value refusal usually reads, which is why it is not the
    // marker: a proxy wording a real field refusal this way still has to be answered.
    const supports = openai();
    const { send } = modelThatRefuses(NO_EFFORT_FIELD);
    await expect(negotiate(supports, send, { model: "gpt-5" })).resolves.toBe("answered");
    expect(modelCapabilitiesFor(supports, "gpt-5").reasoningEffort).toBe(false);
  });

  it("lets the model keep the temperature it was built with", async () => {
    const supports = openai();
    const { send } = modelThatRefuses(OWN_TEMPERATURE);
    await expect(negotiate(supports, send, { model: "gpt-5" })).resolves.toBe("answered");
    expect(modelCapabilitiesFor(supports, "gpt-5").chosenTemperature).toBe(false);
  });

  it("passes on a temperature the model would not take, rather than dropping the field", async () => {
    // The same trade as the effort above, and the one the field-name test alone got wrong. A
    // model that answers any of these takes a temperature perfectly well — the number was out
    // of range, or the refusal was about another field entirely. Dropping ours succeeds at the
    // model's own default, latched for the life of the process, with the settings row still
    // reading what the operator typed and nothing anywhere saying it had stopped meaning it.
    for (const refusal of [TEMPERATURE_OUT_OF_RANGE, TEMPERATURE_TOO_HIGH, ANOTHER_FIELD_REFUSED]) {
      const supports = openai();
      const { send } = modelThatRefuses(refusal);
      await expect(negotiate(supports, send, { model: "gpt-5" })).rejects.toThrow(refusal.message);
      expect(send).toHaveBeenCalledTimes(1);
      expect(modelCapabilitiesFor(supports, "gpt-5").chosenTemperature).toBe(true);
    }
  });

  it("keeps going after the first answer, since a reasoning model has two waiting", async () => {
    // The one that made this a loop rather than a retry: answering `max_tokens` and stopping
    // handed the caller the temperature refusal instead of the turn.
    const supports = openai();
    const { send, asked } = modelThatRefuses(WANTS_COMPLETION_LIMIT, OWN_TEMPERATURE);
    await expect(negotiate(supports, send, { model: "gpt-5" })).resolves.toBe("answered");
    expect(asked).toEqual(
      [
        { reasoningEffort: true, legacyTokenLimit: true, chosenTemperature: true },
        { reasoningEffort: true, legacyTokenLimit: false, chosenTemperature: true },
        { reasoningEffort: true, legacyTokenLimit: false, chosenTemperature: false },
      ].map((flags) => ({
        ...flags,
        refusedFields: new Set(),
        structuredOutput: true,
        refusedEfforts: new Set(),
        assistantPrefill: true,
      })),
    );
  });

  it("answers the endpoint's refusal and the model's in the one loop", async () => {
    const supports = openai();
    const { send } = modelThatRefuses(NO_USAGE, NO_EFFORT);
    await expect(negotiate(supports, send, { model: "gpt-4o" })).resolves.toBe("answered");
    expect(supports.usageInStream).toBe(false);
    expect(modelCapabilitiesFor(supports, "gpt-4o").reasoningEffort).toBe(false);
  });

  it("passes a model's refusal on when no model was named", async () => {
    // Additive: a caller that never passes `model` is where it was, and the refusal reaches it
    // rather than being answered on a memory that does not exist.
    const { send } = modelThatRefuses(NO_EFFORT);
    await expect(negotiate(openai(), send)).rejects.toThrow("reasoning_effort");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("says what it gave up on", async () => {
    const notices: string[] = [];
    const { send } = modelThatRefuses(NO_EFFORT, WANTS_COMPLETION_LIMIT, OWN_TEMPERATURE);
    await negotiate(openai(), send, {
      model: "gpt-5",
      onNotice: (message) => notices.push(message),
    });
    // Named, because these latch for the life of the process and the notice is the only
    // announcement that one did. On a consumer where the model is a per-turn setting, a bare
    // "model" is the same line for every model on the endpoint.
    expect(notices).toEqual([
      "gpt-5 does not take a reasoning effort; retrying without one",
      "gpt-5 wants max_completion_tokens; retrying with the limit spelled that way",
      "gpt-5 takes only its own temperature; retrying without ours",
    ]);
  });

  it("keeps the two levels tellable apart by their first word", async () => {
    // The endpoint's notices open with `server` and the model's with its own name, so a reader
    // knows which level latched without parsing the rest of the line.
    const notices: string[] = [];
    const supports = capabilitiesFor("http://one-box/v1");
    const refusals = [NO_USAGE, NO_EFFORT];
    const send = async () => {
      const refusal = refusals.shift();
      if (refusal) throw refusal;
      return "answered";
    };
    await negotiate(supports, send, {
      model: "qwen3-30b",
      onNotice: (message) => notices.push(message),
    });
    expect(notices.map((notice) => notice.split(" ")[0])).toEqual(["server", "qwen3-30b"]);
  });

  it("gives up rather than looping on a model that will not stop complaining", async () => {
    const { send } = modelThatRefuses(NO_EFFORT, NO_EFFORT);
    await expect(negotiate(openai(), send, { model: "gpt-4o" })).rejects.toThrow(
      "reasoning_effort",
    );
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("negotiate, for a field the caller can do without", () => {
  const vllm = () => capabilitiesFor("http://vllm:8000/v1");
  const UNRECOGNIZED = new Error("400 Unrecognized request argument supplied: min_p");
  const UNKNOWN = new Error("400 Unknown parameter: 'chat_template_kwargs.enable_thinking'.");
  const SEVERAL = new Error("400 Unrecognized request arguments supplied: id_slot, min_p");

  it("drops a named droppable field and remembers it for the model", async () => {
    const supports = vllm();
    const notices: string[] = [];
    const { send, asked } = modelThatRefuses(UNRECOGNIZED);
    await expect(
      negotiate(supports, send, {
        model: "qwen",
        droppable: ["min_p", "top_k"],
        onNotice: (message) => notices.push(message),
      }),
    ).resolves.toBe("answered");
    expect(asked.map((model) => [...model.refusedFields])).toEqual([[], ["min_p"]]);
    expect(notices).toEqual(["qwen does not take min_p; retrying without it"]);
    expect(modelCapabilitiesFor(supports, "qwen").refusedFields.has("min_p")).toBe(true);
    expect(modelCapabilitiesFor(supports, "llama").refusedFields.size).toBe(0);
  });

  it("answers a nested name at its top-level field", async () => {
    const supports = vllm();
    const { send } = modelThatRefuses(UNKNOWN);
    await negotiate(supports, send, { model: "qwen", droppable: ["chat_template_kwargs"] });
    expect([...modelCapabilitiesFor(supports, "qwen").refusedFields]).toEqual([
      "chat_template_kwargs",
    ]);
  });

  it("drops every droppable field a refusal lists, in one retry", async () => {
    const supports = vllm();
    const notices: string[] = [];
    const { send } = modelThatRefuses(SEVERAL);
    await negotiate(supports, send, {
      model: "qwen",
      droppable: ["id_slot", "min_p"],
      onNotice: (message) => notices.push(message),
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(notices).toEqual(["qwen does not take id_slot, min_p; retrying without them"]);
  });

  it("passes on a field that is not the caller's to drop", async () => {
    const { send } = modelThatRefuses(UNRECOGNIZED);
    await expect(negotiate(vllm(), send, { model: "qwen", droppable: ["top_k"] })).rejects.toThrow(
      "min_p",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("passes the refusal on when no model was named", async () => {
    const { send } = modelThatRefuses(UNRECOGNIZED);
    await expect(negotiate(vllm(), send, { droppable: ["min_p"] })).rejects.toThrow("min_p");
  });

  it("gives up on a server that refuses the field it was not sent", async () => {
    const { send } = modelThatRefuses(UNRECOGNIZED, UNRECOGNIZED);
    await expect(negotiate(vllm(), send, { model: "qwen", droppable: ["min_p"] })).rejects.toThrow(
      "min_p",
    );
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("two runs on one endpoint", () => {
  it("does not let the run that lost the race die on the answered refusal", async () => {
    // `capabilitiesFor` hands the same object to both, which is the point of it — the refusal
    // is a fact about the server, not about either run.
    const supports = capabilitiesFor("http://local/v1");
    const send = async (as: { strictSchemas: boolean }) => {
      if (as.strictSchemas) throw NO_GRAMMAR;
      return "answered";
    };

    // Started together against a fresh box, so both are built with strictSchemas still on and
    // both come back refused. Whichever loses the race finds the flag already latched off.
    const [first, second] = await Promise.all([
      negotiate(supports, send),
      negotiate(supports, send),
    ]);

    expect([first, second]).toEqual(["answered", "answered"]);
    expect(supports.strictSchemas).toBe(false);
  });

  it("does not let the run that lost the race die on an answered model refusal", async () => {
    // The same race one level down: `modelCapabilitiesFor` hands both runs the same object, so
    // the loser finds the flag already latched off and has to send again rather than give up.
    const supports = capabilitiesFor("https://api.openai.com/v1");
    const send = async (_s: Capabilities, _p: Produced, model: ModelCapabilities | undefined) => {
      if (model?.reasoningEffort) throw NO_EFFORT;
      return "answered";
    };

    const both = await Promise.all([
      negotiate(supports, send, { model: "gpt-4o" }),
      negotiate(supports, send, { model: "gpt-4o" }),
    ]);

    expect(both).toEqual(["answered", "answered"]);
    expect(modelCapabilitiesFor(supports, "gpt-4o").reasoningEffort).toBe(false);
  });

  it("still gives up on a refusal nothing here knows how to answer", async () => {
    const supports = capabilitiesFor("http://local/v1");
    const send = vi.fn(async () => {
      throw new Error("401 Incorrect API key provided");
    });

    // The re-send above is bounded by the flags latching off. Nothing latched here, so this has
    // to leave on the first pass rather than sending the same rejected request forever.
    await expect(negotiate(supports, send)).rejects.toThrow("401");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
