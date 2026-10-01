import { describe, expect, it } from "vitest";
import { can, toRole } from "../src/lib/roles";

describe("roles mirror the backend matrix (docs/DECISIONS.md D5)", () => {
  it("maps Better Auth roles", () => {
    expect(toRole("owner")).toBe("owner");
    expect(toRole("admin")).toBe("operator");
    expect(toRole("member")).toBe("viewer");
    expect(toRole("root")).toBeNull();
    expect(toRole(undefined)).toBeNull();
  });
  it("viewer can do nothing that changes state", () => {
    expect(can.addDevice("viewer")).toBe(false);
    expect(can.snapshot("viewer")).toBe(false);
    expect(can.audit("viewer")).toBe(false);
  });
  it("operator adds devices and takes snapshots but cannot read audit", () => {
    expect(can.addDevice("operator")).toBe(true);
    expect(can.snapshot("operator")).toBe(true);
    expect(can.audit("operator")).toBe(false);
  });
  it("owner can do everything; an unknown role can do nothing", () => {
    expect([can.addDevice("owner"), can.snapshot("owner"), can.audit("owner")]).toEqual([true, true, true]);
    expect([can.addDevice(null), can.snapshot(null), can.audit(null)]).toEqual([false, false, false]);
  });
});
