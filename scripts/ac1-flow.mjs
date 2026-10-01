const B = "http://127.0.0.1:3000";
const O = "http://localhost:3000";
let jar = "";
const H = (hasBody) => ({
  ...(hasBody ? { "content-type": "application/json" } : {}),
  Origin: O,
  ...(jar ? { cookie: jar } : {}),
});
async function call(m, p, b) {
  const r = await fetch(B + p, { method: m, headers: H(!!b), body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) jar = sc.map((c) => c.split(";")[0]).join("; ");
  const t = r.headers.get("content-type") || "";
  const ab = await r.arrayBuffer();
  const d = t.includes("json") ? JSON.parse(Buffer.from(ab).toString()) : Buffer.from(ab);
  return { status: r.status, type: t, data: d };
}
const e = `ac1-${Date.now()}@example.test`;
console.log(
  "signup",
  (await call("POST", "/api/auth/sign-up/email", { email: e, password: "Dummy-Demo-Pass-123", name: "AC1" }))
    .status,
);
const org = await call("POST", "/api/auth/organization/create", {
  name: "AC1 Org",
  slug: `ac1-${Date.now()}`,
});
console.log("org", org.status, org.data && org.data.id);
console.log(
  "set-active",
  (await call("POST", "/api/auth/organization/set-active", { organizationId: org.data.id })).status,
);
const site = await call("POST", "/v1/sites", { name: "Demo site" });
console.log("site", site.status, site.data && site.data.id);
const dev = await call("POST", "/v1/devices", {
  siteId: site.data.id,
  name: "Mock NVR",
  host: "172.28.0.3",
  port: 18081,
  username: "dummy-admin",
  password: "dummy-password",
});
console.log("add-device", dev.status, JSON.stringify(dev.data).slice(0, 260));
const cam = dev.data.cameras[0].id;
const snap = await call("POST", `/v1/cameras/${cam}/snapshot`);
console.log("snapshot", snap.status, snap.type);
if (Buffer.isBuffer(snap.data))
  console.log("  bytes", snap.data.length, "magic", snap.data.subarray(0, 4).toString("hex"));
else console.log("  BODY", JSON.stringify(snap.data));
const aud = await call("GET", "/v1/audit");
console.log("audit", aud.status, JSON.stringify(aud.data).slice(0, 700));
