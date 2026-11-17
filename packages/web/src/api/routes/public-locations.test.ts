import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerPublicLocationsRoute } from "./public-locations";

describe("GET /api/public/locations", () => {
  test("returns active Admin locations through a safe public projection", async () => {
    const app = new Hono();
    registerPublicLocationsRoute(app, async () => [
      {
        id: "private-id",
        code: "CMBHUB",
        name: "Colombo Main Hub",
        address: "Colombo",
        type: "hub",
        status: "active",
        lat: 6_968_600,
        lng: 79_891_200,
        phone: "+94123456789",
      },
    ]);

    const response = await app.request("/api/public/locations");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=30, stale-while-revalidate=60");
    expect(await response.json()).toEqual({
      locations: [
        {
          code: "CMBHUB",
          name: "Colombo Main Hub",
          address: "Colombo",
          type: "hub",
          latitude: 6.9686,
          longitude: 79.8912,
        },
      ],
    });
  });
});
