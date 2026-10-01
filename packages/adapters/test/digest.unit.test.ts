import { describe, expect, it } from "vitest";
import { buildDigestAuthorization, parseDigestChallenge } from "../src/http-digest";

describe("HTTP Digest", () => {
  it("parses a challenge", () => {
    const c = parseDigestChallenge('Digest realm="cam", nonce="abc", qop="auth", algorithm=MD5');
    expect(c).toMatchObject({ realm: "cam", nonce: "abc", qop: "auth", algorithm: "MD5" });
  });
  it("matches the RFC 2617 example vector", () => {
    const header = buildDigestAuthorization({
      challenge: {
        realm: "testrealm@host.com",
        nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
        qop: "auth",
        opaque: "5ccc069c403ebaf9f0171e9517f40e41",
        algorithm: "MD5",
      },
      username: "Mufasa",
      password: "Circle Of Life",
      method: "GET",
      uri: "/dir/index.html",
      cnonce: "0a4f113b",
      nc: 1,
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
  });
  it("refuses Basic challenges (no plaintext passwords over HTTP)", () => {
    expect(() => parseDigestChallenge('Basic realm="cam"')).toThrow(/digest/i);
  });
});
