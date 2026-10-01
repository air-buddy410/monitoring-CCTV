import { describe, expect, it } from "vitest";
import { can, toRole } from "../src/lib/roles";

describe("roles mirror the backend matrix (docs/DECISIONS.md D5)", () => {
  it("maps Better Auth roles", () => {
    expect(toRole("owner")).toBe("owner");
    expect(toRole("admin")).toBe("operator");
    expect(toRole("member")).toBe("viewer");
    expect(toRole("noc")).toBe("noc");
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
  it("noc onboards and reads audit and manages grants, but never takes snapshots (video)", () => {
    expect(can.addDevice("noc")).toBe(true);
    expect(can.audit("noc")).toBe(true);
    expect(can.manageGrants("noc")).toBe(true);
    expect(can.snapshot("noc")).toBe(false);
  });
  it("only owner and noc manage grants", () => {
    expect([can.manageGrants("owner"), can.manageGrants("noc")]).toEqual([true, true]);
    expect([can.manageGrants("operator"), can.manageGrants("viewer"), can.manageGrants(null)]).toEqual([
      false,
      false,
      false,
    ]);
  });
});
