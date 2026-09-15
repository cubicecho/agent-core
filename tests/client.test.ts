import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("openai", () => ({
  default: class {
    models = { list };
  },
}));

const {
  configureClients,
  contextLimitFor,
  endpointId,
  endpointKey,
  firstTokenMs,
  getClient,
  listModels,
  NO_KEY,
  resetClients,
} = await import("../src/client.ts");

const endpoint = { baseUrl: "http://local/v1", apiKey: "", requestTimeoutSeconds: 60 };
/** What a listing endpoint answers with: the OpenAI shape plus whatever window key it uses. */
const listing = (...models: ({ id: string } & Record<string, unknown>)[]) => ({ data: models });

/** A fetch answering each native route with a body, and 404 for any route not given. */
const routes = (answers: Record<string, unknown>) =>
  vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    return path in answers
      ? new Response(JSON.stringify(answers[path]), { status: 200 })
      : new Response("not found", { status: 404 });
  });

/**
 * `MAX_CLIENTS` in `src/client.ts`, the default `configureClients` starts from. Written out rather
 * than read back from the module, so a test cannot pass when the default moves.
 */
const MAX_CLIENTS = 32;
/** `LISTING_MISS_MS`, likewise. A miss expires *at* it, not after it. */
const LISTING_MISS_MS = 30_000;

describe("contextLimitFor", () => {
  beforeEach(() => {
    // Faked for the clock rather than for any timer: how long a model stays not-listed is
    // measured with `Date.now()`, and the alternative is a test that waits half a minute.
    vi.useFakeTimers();
    resetClients();
    list.mockReset();
    // A server with neither native route, which is what every test below not about them wants.
    vi.stubGlobal("fetch", routes({}));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads the window off the endpoint's listing", async () => {
    // vLLM's spelling, top-level.
    list.mockResolvedValue(listing({ id: "qwen", max_model_len: 32768 }));
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(32768);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("reads llama.cpp's trained window from under meta, where nothing better answers", async () => {
    list.mockResolvedValue(
      listing({ id: "qwen", owned_by: "llamacpp", meta: { n_vocab: 151936, n_ctx_train: 262144 } }),
    );
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(262144);
  });

  it("prefers the window llama.cpp is serving over the one the model was trained with", async () => {
    // A 256k model started at `-c 16384`: the listing says one, `/props` the other.
    list.mockResolvedValue(listing({ id: "qwen", meta: { n_ctx_train: 262144 } }));
    const fetch = routes({ "/props": { default_generation_settings: { n_ctx: 16384 } } });
    vi.stubGlobal("fetch", fetch);
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(16384);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://local/props?model=qwen");
    expect(list).not.toHaveBeenCalled();
  });

  it("reads the window LM Studio has the model loaded in", async () => {
    vi.stubGlobal(
      "fetch",
      routes({
        "/api/v0/models": {
          data: [
            { id: "other", loaded_context_length: 4096 },
            { id: "qwen", max_context_length: 131072, loaded_context_length: 32768 },
          ],
        },
      }),
    );
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(32768);
  });

  it("stops asking a server that has neither route", async () => {
    const fetch = routes({});
    vi.stubGlobal("fetch", fetch);
    list.mockResolvedValue(listing({ id: "qwen", max_model_len: 32768 }));
    await contextLimitFor({ ...endpoint, model: "qwen" });
    await contextLimitFor({ ...endpoint, model: "llama" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not remember a server it could not reach", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetch);
    list.mockResolvedValue(listing({ id: "qwen", max_model_len: 32768 }));
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(32768);
    await contextLimitFor({ ...endpoint, model: "qwen" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("takes the operator's own number without asking anyone", async () => {
    await expect(contextLimitFor({ ...endpoint, model: "qwen" }, 16384)).resolves.toBe(16384);
    expect(list).not.toHaveBeenCalled();
  });

  it("asks again for a model that was not in the listing", async () => {
    // The shape this exists for: a model pulled onto a box that has been up for a week. The
    // guard used to be on the listing being present rather than on the model being in it, so
    // the first miss answered zero and went on answering zero until the process restarted.
    list.mockResolvedValueOnce(listing({ id: "qwen", context_length: 32768 }));
    await expect(contextLimitFor({ ...endpoint, model: "llama" })).resolves.toBe(0);

    // Not immediately, though: the miss stands for `LISTING_MISS_MS` so a model that is never
    // coming costs one listing a half-minute rather than one a call.
    vi.advanceTimersByTime(LISTING_MISS_MS);
    list.mockResolvedValueOnce(
      listing({ id: "qwen", context_length: 32768 }, { id: "llama", context_length: 8192 }),
    );
    await expect(contextLimitFor({ ...endpoint, model: "llama" })).resolves.toBe(8192);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not re-list for a model the endpoint has just said it does not have", async () => {
    // The permanent mismatch, which is the common one: a `-a` alias, a `:free` suffix, a typo in
    // a settings row. The answer is the same zero every time and used to cost a round trip to
    // reach it, on every call, for the life of the process.
    list.mockResolvedValue(listing({ id: "qwen", context_length: 32768 }));
    await expect(contextLimitFor({ ...endpoint, model: "llama" })).resolves.toBe(0);
    await expect(contextLimitFor({ ...endpoint, model: "llama" })).resolves.toBe(0);
    vi.advanceTimersByTime(LISTING_MISS_MS - 1);
    await expect(contextLimitFor({ ...endpoint, model: "llama" })).resolves.toBe(0);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("holds the miss against one model rather than the endpoint", async () => {
    // One absent model must not answer for the next one asked about, or a run on a model the
    // endpoint really does serve reads zero for the first half-minute of the process.
    list.mockResolvedValue(listing({ id: "qwen", context_length: 32768 }));
    await expect(contextLimitFor({ ...endpoint, model: "llama" })).resolves.toBe(0);
    await expect(contextLimitFor({ ...endpoint, model: "mistral" })).resolves.toBe(0);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps asking about a model whose listing never landed", async () => {
    // A failed listing is not an absence, so it is not remembered as one. The endpoint that was
    // down when the run started is asked again on the next call rather than in half a minute.
    list.mockRejectedValue(new Error("connection refused"));
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(0);
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(0);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not ask again once the listing names the model", async () => {
    list.mockResolvedValue(listing({ id: "qwen", context_length: 32768 }));
    await contextLimitFor({ ...endpoint, model: "qwen" });
    await contextLimitFor({ ...endpoint, model: "qwen" });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("answers zero for a model the endpoint lists without a window", async () => {
    list.mockResolvedValue(listing({ id: "qwen" }));
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(0);
  });

  it("keeps a failed listing from becoming a failed run", async () => {
    list.mockRejectedValue(new Error("connection refused"));
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(0);
  });

  it("leaves the last good listing in place when a later one fails", async () => {
    await listModels(endpoint).catch(() => {});
    list.mockResolvedValueOnce(listing({ id: "qwen", context_length: 32768 }));
    await listModels(endpoint);

    list.mockRejectedValue(new Error("down"));
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(32768);
  });
});

describe("getClient", () => {
  beforeEach(() => {
    resetClients();
  });

  const box = (n: number) => ({ ...endpoint, baseUrl: `http://box-${n}/v1` });

  it("hands one endpoint the same client every time", () => {
    expect(getClient(endpoint)).toBe(getClient(endpoint));
  });

  it("never lets two endpoints share a client", () => {
    expect(getClient(box(1))).not.toBe(getClient(box(2)));
  });

  it("keeps a full pool", () => {
    const first = getClient(box(0));
    for (let n = 1; n < MAX_CLIENTS; n++) getClient(box(n));
    expect(getClient(box(0))).toBe(first);
  });

  it("drops the oldest to make room", () => {
    // What this is a backstop for is a consumer keying on a per-user API key rather than on a
    // deployment: unbounded, that is one client and one connection pool per tenant, held for the
    // life of the process. Evicted costs a pool and nothing else — the next call builds another.
    const first = getClient(box(0));
    for (let n = 1; n <= MAX_CLIENTS; n++) getClient(box(n));
    expect(getClient(box(0))).not.toBe(first);
  });

  it("counts a client asked for again as the youngest", () => {
    const first = getClient(box(0));
    const second = getClient(box(1));
    for (let n = 2; n < MAX_CLIENTS; n++) getClient(box(n));
    // The oldest, asked for again — so what the next arrival evicts is the one behind it. Without
    // the re-insertion this is the endpoint a busy consumer uses most and rebuilds most often.
    getClient(box(0));
    getClient(box(MAX_CLIENTS));
    expect(getClient(box(0))).toBe(first);
    expect(getClient(box(1))).not.toBe(second);
  });
});

describe("configureClients", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetClients();
    list.mockReset();
    vi.stubGlobal("fetch", routes({}));
  });

  afterEach(() => {
    resetClients();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const box = (n: number) => ({ ...endpoint, baseUrl: `http://box-${n}/v1` });

  it("starts from the defaults and says what is in force", () => {
    expect(configureClients()).toEqual({ maxClients: MAX_CLIENTS, listingMissMs: LISTING_MISS_MS });
    expect(configureClients({ maxClients: 64 })).toEqual({
      maxClients: 64,
      listingMissMs: LISTING_MISS_MS,
    });
  });

  it("ignores anything that is not a number above zero", () => {
    configureClients({ maxClients: 4, listingMissMs: 1000 });
    for (const bad of [0, -1, Number.NaN, "8" as never, undefined]) {
      expect(configureClients({ maxClients: bad, listingMissMs: bad })).toEqual({
        maxClients: 4,
        listingMissMs: 1000,
      });
    }
  });

  it("keeps more clients once raised", () => {
    configureClients({ maxClients: MAX_CLIENTS * 2 });
    const first = getClient(box(0));
    for (let n = 1; n < MAX_CLIENTS * 2; n++) getClient(box(n));
    expect(getClient(box(0))).toBe(first);
  });

  it("evicts down at once when lowered below the pool, least recently asked for first", () => {
    const clients = [0, 1, 2, 3].map((n) => getClient(box(n)));
    getClient(box(0));
    configureClients({ maxClients: 2 });
    // Asked for again, box 0 is younger than 1 and 2, so what survives is 3 and 0.
    expect(getClient(box(3))).toBe(clients[3]);
    expect(getClient(box(0))).toBe(clients[0]);
    expect(getClient(box(1))).not.toBe(clients[1]);
  });

  it("asks about a missed model again after the configured window", async () => {
    configureClients({ listingMissMs: 1000 });
    list.mockResolvedValue(listing({ id: "qwen", context_length: 32768 }));
    await expect(contextLimitFor({ ...endpoint, model: "llama" })).resolves.toBe(0);
    vi.advanceTimersByTime(999);
    await contextLimitFor({ ...endpoint, model: "llama" });
    expect(list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await contextLimitFor({ ...endpoint, model: "llama" });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("goes back to the defaults on resetClients", () => {
    configureClients({ maxClients: 1, listingMissMs: 1 });
    resetClients();
    expect(configureClients()).toEqual({ maxClients: MAX_CLIENTS, listingMissMs: LISTING_MISS_MS });
  });
});

describe("endpointKey and endpointId", () => {
  it("read an absent or empty key as NO_KEY, and nothing but the URL and key", () => {
    const key = JSON.stringify(["http://local/v1", NO_KEY]);
    expect(endpointKey({ baseUrl: "http://local/v1" })).toBe(key);
    expect(endpointKey({ ...endpoint })).toBe(key);
    expect(endpointId({ baseUrl: "http://local/v1", apiKey: "" })).toBe(
      endpointId({ baseUrl: "http://local/v1" }),
    );
    expect(endpointId({ baseUrl: "http://local/v1", apiKey: "sk-1" })).toMatch(/^[0-9a-f]{64}$/);
    expect(endpointId({ baseUrl: "http://local/v1", apiKey: "sk-1" })).not.toContain("sk-1");
  });

  it("are exported from the package root", async () => {
    const root = await import("../src/index.ts");
    expect(root.endpointKey).toBe(endpointKey);
    expect(root.endpointId).toBe(endpointId);
    expect(root.configureClients).toBe(configureClients);
  });
});

describe("firstTokenMs", () => {
  it("is five idle windows unless the endpoint names its own", () => {
    expect(firstTokenMs({ requestTimeoutSeconds: 60 })).toBe(300_000);
    expect(firstTokenMs({ requestTimeoutSeconds: 60, firstTokenSeconds: 600 })).toBe(600_000);
  });

  it("is no limit where there is none to multiply, or it is turned off", () => {
    expect(firstTokenMs({})).toBeUndefined();
    expect(firstTokenMs({ requestTimeoutSeconds: 60, firstTokenSeconds: 0 })).toBeUndefined();
  });
});
