import { describe, expect, it } from "vitest";
import {
  OnvifMethodNotAllowedError,
  assertOperationAllowed,
  extractSoapOperation,
  isOperationAllowed,
} from "../src/index";

describe("ONVIF operation whitelist", () => {
  it.each([
    "GetDeviceInformation",
    "GetProfiles",
    "GetCapabilities",
    "GetStreamUri",
    "GetSnapshotUri",
    "GetSystemDateAndTime",
    "GetServices",
    "FindRecordings",
    "CreatePullPointSubscription",
    "PullMessages",
    "Unsubscribe",
    "ContinuousMove",
    "Stop",
    "GotoPreset",
  ])("allows %s", (op) => {
    expect(isOperationAllowed(op)).toBe(true);
  });

  it.each([
    "SetSystemDateAndTime",
    "SetHostname",
    "SetUser",
    "SetNetworkInterfaces",
    "CreateUsers",
    "CreateUser",
    "DeleteUsers",
    "SystemReboot",
    "SetSystemFactoryDefault",
    "StartFirmwareUpgrade",
    "UpgradeSystemFirmware",
    "RelativeMove",
    "AbsoluteMove",
    "SetPreset",
    "RemovePreset",
    "CreateProfile",
    "DeleteProfile",
    "AddVideoEncoderConfiguration",
    "SetVideoEncoderConfiguration",
    "StartStreamingOutput",
    "",
    "GetX\u0000SetUser",
    "Get Profiles",
    "getProfiles",
    "GetProfiles; SystemReboot",
    "../GetProfiles",
  ])("denies %j", (op) => {
    expect(isOperationAllowed(op)).toBe(false);
    expect(() => assertOperationAllowed(op)).toThrow(OnvifMethodNotAllowedError);
  });

  it("error carries a stable code and the operation name only", () => {
    try {
      assertOperationAllowed("SystemReboot");
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "onvif_method_not_allowed", operation: "SystemReboot" });
    }
  });

  it("extracts the operation from a SOAP envelope (any prefix) and fails closed", () => {
    const env = (body: string) =>
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Header><x/></s:Header><s:Body>${body}</s:Body></s:Envelope>`;
    expect(extractSoapOperation(env('<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>'))).toBe("GetProfiles");
    expect(extractSoapOperation(env('<trt:GetProfiles xmlns:trt="x"/>'))).toBe("GetProfiles");
    expect(extractSoapOperation(env('<tds:SystemReboot xmlns:tds="x"></tds:SystemReboot>'))).toBe("SystemReboot");
    expect(extractSoapOperation("<garbage/>")).toBeNull();
    expect(extractSoapOperation("")).toBeNull();
  });
});
