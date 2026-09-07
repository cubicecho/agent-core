import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("openai", () => ({
  default: class {
    models = { list };
  },
}));

const { contextLimitFor, listModels, resetClients } = await import("../src/client.ts");

const endpoint = { baseUrl: "http://local/v1", apiKey: "", requestTimeoutSeconds: 60 };
/** What a listing endpoint answers with: the OpenAI shape plus whatever window key it uses. */
const listing = (...models: { id: string; context_length?: number }[]) => ({ data: models });

describe("contextLimitFor", () => {
  beforeEach(() => {
    resetClients();
    list.mockReset();
  });

  it("reads the window off the endpoint's listing", async () => {
    list.mockResolvedValue(listing({ id: "qwen", context_length: 32768 }));
    await expect(contextLimitFor({ ...endpoint, model: "qwen" })).resolves.toBe(32768);
    expect(list).toHaveBeenCalledTimes(1);
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

    list.mockResolvedValueOnce(
      listing({ id: "qwen", context_length: 32768 }, { id: "llama", context_length: 8192 }),
    );
    await expect(contextLimitFor({ ...endpoint, model: "llama" })).resolves.toBe(8192);
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
