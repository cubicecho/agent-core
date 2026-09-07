import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Capabilities,
  capabilitiesFor,
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
      if (model) asked.push({ ...model });
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
    expect(supports).toEqual({ strictSchemas: true, usageInStream: true, models: new Map() });
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

  it("passes on an effort the model does not offer, rather than giving up reasoning", async () => {
    // A model that answers this reasons perfectly well — it was handed a value off a list this
    // package does not know. Dropping the field succeeds at the model's own default effort,
    // which is neither what the caller asked for nor something it can see, and the drop latches
    // for every later turn.
    const supports = openai();
    const { send } = modelThatRefuses(NO_SUCH_EFFORT);
    await expect(negotiate(supports, send, { model: "gpt-5" })).rejects.toThrow(
      "Unsupported value",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(modelCapabilitiesFor(supports, "gpt-5").reasoningEffort).toBe(true);
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
    expect(asked).toEqual([
      { reasoningEffort: true, legacyTokenLimit: true, chosenTemperature: true },
      { reasoningEffort: true, legacyTokenLimit: false, chosenTemperature: true },
      { reasoningEffort: true, legacyTokenLimit: false, chosenTemperature: false },
    ]);
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
