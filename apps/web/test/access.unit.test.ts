import { describe, expect, it } from "vitest";
import { effectiveAccess, type GrantT, snapshotAccess } from "../src/lib/access";

const cam = { id: "cam_1", siteId: "site_1" };
const g = (over: Partial<GrantT>): GrantT => ({
  id: "grt_1",
  userId: "u1",
  scope: "camera",
  scopeId: "cam_1",
  permission: "view",
  createdBy: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("effectiveAccess (display copy of the server rule)", () => {
  it("owner reaches everything, noc and unknown roles reach no video", () => {
    expect(effectiveAccess("owner", cam, [])).toBe("operate");
    expect(effectiveAccess("noc", cam, [g({ permission: "operate" })])).toBe("none");
    expect(effectiveAccess(null, cam, [g({ permission: "operate" })])).toBe("none");
  });

  it("operator and viewer have no access without a grant (default deny)", () => {
    expect(effectiveAccess("operator", cam, [])).toBe("none");
    expect(effectiveAccess("viewer", cam, [])).toBe("none");
  });

  it("a camera grant or a site grant applies, another camera or site does not", () => {
    expect(effectiveAccess("operator", cam, [g({ permission: "operate" })])).toBe("operate");
    expect(
      effectiveAccess("operator", cam, [g({ scope: "site", scopeId: "site_1", permission: "operate" })]),
    ).toBe("operate");
    expect(effectiveAccess("operator", cam, [g({ scopeId: "cam_2", permission: "operate" })])).toBe("none");
    expect(
      effectiveAccess("operator", cam, [g({ scope: "site", scopeId: "site_9", permission: "operate" })]),
    ).toBe("none");
  });

  it("the highest grant wins, and a viewer never operates", () => {
    const both = [
      g({ permission: "view" }),
      g({ id: "grt_2", scope: "site", scopeId: "site_1", permission: "operate" }),
    ];
    expect(effectiveAccess("operator", cam, both)).toBe("operate");
    expect(effectiveAccess("viewer", cam, both)).toBe("view");
  });
});

describe("snapshotAccess", () => {
  it("explains each refusal", () => {
    expect(snapshotAccess("viewer", cam, [g({ permission: "operate" })])).toEqual({
      allowed: false,
      reason: "role",
    });
    expect(snapshotAccess("noc", cam, [])).toEqual({ allowed: false, reason: "role" });
    expect(snapshotAccess("operator", cam, [])).toEqual({ allowed: false, reason: "no_grant" });
    expect(snapshotAccess("operator", cam, [g({ permission: "view" })])).toEqual({
      allowed: false,
      reason: "view_only",
    });
    expect(snapshotAccess("operator", cam, [g({ permission: "operate" })])).toEqual({ allowed: true });
    expect(snapshotAccess("owner", cam, [])).toEqual({ allowed: true });
  });
});
