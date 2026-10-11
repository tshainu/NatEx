import { describe, expect, test } from "bun:test";
import { cloneRequestForReplay } from "./request-replay";

describe("oRPC Request replay after token refresh", () => {
  test("a reserved clone remains readable after the first fetch consumes the request body", async () => {
    const body = JSON.stringify({ procedure: "awbBatches.checkBranch", awb: "NX1234567890" });
    const request = new Request("https://natex.test/api/rpc/awbBatches.checkBranch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const retryRequest = cloneRequestForReplay(request);

    await request.text(); // models the browser fetch consuming the first Request body

    expect(request.bodyUsed).toBe(true);
    expect(retryRequest.bodyUsed).toBe(false);
    expect(await retryRequest.text()).toBe(body);
  });
});
