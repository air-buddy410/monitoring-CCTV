// Verifikasi AC4 (isolasi tenant), AC5 (tidak ada bocor sandi), AC7 (OpenAPI) pada stack docker.
const B = "http://127.0.0.1:3000";
const O = "http://localhost:3000";

function mkSession() {
  let jar = "";
  const H = (hasBody) => ({
    ...(hasBody ? { "content-type": "application/json" } : {}),
    Origin: O,
    ...(jar ? { cookie: jar } : {}),
  });
  return async function call(m, p, b) {
    const r = await fetch(B + p, { method: m, headers: H(!!b), body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) jar = sc.map((c) => c.split(";")[0]).join("; ");
    const t = r.headers.get("content-type") || "";
    const ab = await r.arrayBuffer();
    const d = t.includes("json") ? JSON.parse(Buffer.from(ab).toString()) : Buffer.from(ab);
    return { status: r.status, type: t, data: d, raw: Buffer.from(ab).toString("utf8") };
  };
}

async function tenant(label) {
  const call = mkSession();
  await call("POST", "/api/auth/sign-up/email", {
    email: `${label}-${Date.now()}@example.test`,
    password: "Dummy-Demo-Pass-123",
    name: label,
  });
  const org = await call("POST", "/api/auth/organization/create", {
    name: `${label} Org`,
    slug: `${label}-${Date.now()}`,
  });
  await call("POST", "/api/auth/organization/set-active", { organizationId: org.data.id });
  const site = await call("POST", "/v1/sites", { name: `${label} site` });
  return { call, orgId: org.data.id, siteId: site.data.id };
}

const A = await tenant("ac1a");
const Bt = await tenant("ac1b");

// Tenant A punya perangkat + kamera.
const dev = await A.call("POST", "/v1/devices", {
  siteId: A.siteId,
  name: "A NVR",
  host: "172.28.0.3",
  port: 18081,
  username: "dummy-admin",
  password: "dummy-password",
});
const devId = dev.data.device.id;
const camId = dev.data.cameras[0].id;
console.log("A add-device", dev.status, devId);

// AC4: tenant B tidak boleh melihat device/kamera A (404, bukan 403 -> tidak bisa enumerasi).
const bDev = await Bt.call("GET", `/v1/devices/${devId}`);
const bCamSnap = await Bt.call("POST", `/v1/cameras/${camId}/snapshot`);
const bList = await Bt.call("GET", "/v1/devices");
console.log("AC4 B GET device A ->", bDev.status, "(harus 404)");
console.log("AC4 B snapshot camera A ->", bCamSnap.status, "(harus 404)");
console.log("AC4 B list devices count ->", bList.data.items.length, "(harus 0)");

// AC5: sandi perangkat tidak boleh muncul di respons apa pun.
const secret = "dummy-password";
const probes = [
  ["GET", "/v1/devices"],
  ["GET", `/v1/devices/${devId}`],
  ["GET", "/v1/audit"],
];
let leaked = false;
for (const [m, p] of probes) {
  const r = await A.call(m, p);
  if (r.raw.includes(secret)) {
    leaked = true;
    console.log("BOCOR di", p);
  }
}
console.log("AC5 sandi di respons API ->", leaked ? "BOCOR" : "tidak ada (OK)");

// AC7: OpenAPI memuat endpoint slice.
const oa = await A.call("GET", "/docs/json");
const paths = Object.keys(oa.data.paths || {});
const want = [
  "/v1/sites",
  "/v1/devices",
  "/v1/devices/{id}",
  "/v1/cameras",
  "/v1/cameras/{id}/snapshot",
  "/v1/audit",
];
console.log("AC7 openapi", oa.status, "paths:", paths.length);
for (const w of want) console.log("   ", paths.includes(w) ? "OK " : "HILANG ", w);
