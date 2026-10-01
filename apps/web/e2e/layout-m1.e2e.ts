import { expect, test } from "@playwright/test";
import { audit, expectClean } from "./audit";
import {
  closeDb,
  enableTotpViaApi,
  enrollAgentViaApi,
  grantAccess,
  loginUi,
  newMember,
  newTenant,
  seedDevice,
  signInAs,
  startMock,
  totpFromBase32,
  USER_PASSWORD,
  watch,
} from "./support";

test.afterAll(closeDb);

const WIDTHS = [320, 360, 390, 768, 1024, 1440];
const SCHEMES = ["light", "dark"] as const;

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test(`layar M1 (2FA, Keamanan, Akses): tata letak, target, kontras: ${width}px tema ${scheme}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height: width < 720 ? 800 : 900 },
        colorScheme: scheme,
        locale: "id-ID",
        timezoneId: "Asia/Makassar",
      });
      const page = await context.newPage();
      const w = watch(page, [401, 403]);
      const mock = await startMock({ channels: 2 });
      const owner = await newTenant(`m1${width}${scheme}`);
      const operator = await newMember(owner, "m1op", "admin");
      const viewer = await newMember(owner, "m1vw", "member");
      const { device, cameras } = await seedDevice(owner, mock);
      await grantAccess(owner, operator.userId, "camera", cameras[0]?.id as string, "operate");
      await grantAccess(owner, viewer.userId, "camera", cameras[1]?.id as string, "view");
      // view-only for the operator on the second camera: the explained "view only" state
      await grantAccess(owner, operator.userId, "camera", cameras[1]?.id as string, "view");
      // arranged now: confirming 2FA later in this test replaces the owner's API session
      await enrollAgentViaApi(owner, "Agen Tata Letak");

      // second-factor step of the sign-in screen (a separate user who has TOTP)
      const guarded = await newTenant(`m1g${width}${scheme}`);
      const { secret } = await enableTotpViaApi(guarded);
      await loginUi(page, guarded.email);
      await expect(page.getByRole("heading", { name: "Verifikasi dua langkah", exact: true })).toBeVisible();
      expectClean(await audit(page), `2FA kode ${width} ${scheme}`);
      await page.getByRole("button", { name: "Pakai kode cadangan" }).click();
      expectClean(await audit(page), `2FA cadangan ${width} ${scheme}`);
      await page.getByLabel("Kode cadangan").fill("zzzzz");
      await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
      await expect(page.getByText("Kode cadangan belum lengkap.")).toBeVisible();
      expectClean(await audit(page), `2FA galat ${width} ${scheme}`);
      await page.getByRole("button", { name: "Pakai kode autentikator" }).click();
      await page.getByLabel("Kode verifikasi").fill(totpFromBase32(secret));
      await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
      await expect(page).toHaveURL(/\/perangkat/);
      // the session gate may still be activating the organization; its late Set-Cookie would shadow the next user
      await page.waitForLoadState("networkidle");

      // Keamanan: off, mid-setup, on (cookies cleared first so the guarded user's session cannot shadow it)
      await context.clearCookies();
      await signInAs(context, owner);
      await page.goto("/keamanan");
      await expect(page.getByRole("heading", { name: "Verifikasi dua langkah", exact: true })).toBeVisible();
      expectClean(await audit(page), `keamanan mati ${width} ${scheme}`);
      await page.getByLabel("Kata sandi akun, untuk memulai").fill(USER_PASSWORD);
      await page.getByRole("button", { name: "Mulai aktifkan" }).click();
      await expect(page.getByRole("img", { name: "Kode QR untuk aplikasi autentikator" })).toBeVisible();
      expectClean(await audit(page), `keamanan setup ${width} ${scheme}`);
      const key = (await page.getByText("Kunci manual").locator("..").locator(".mono").innerText()).replace(
        /\s/g,
        "",
      );
      await page.getByLabel("Saya sudah menyimpan kode cadangan.").check();
      await page.getByLabel("Kode 6 angka").fill(totpFromBase32(key));
      await page.getByRole("button", { name: "Konfirmasi dan aktifkan" }).click();
      await expect(page.getByText("Verifikasi dua langkah aktif.")).toBeVisible();
      expectClean(await audit(page), `keamanan aktif ${width} ${scheme}`);

      // Akses as owner (with grants and the add dialog), as operator and as viewer
      await page.goto("/akses");
      await expect(page.getByRole("heading", { name: "Akses kamera" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Cabut akses/ }).first()).toBeVisible();
      expectClean(await audit(page), `akses pemilik ${width} ${scheme}`);
      await page.getByRole("button", { name: "Beri akses" }).click();
      await expect(page.getByRole("dialog", { name: "Beri akses" })).toBeVisible();
      expectClean(await audit(page), `dialog beri akses ${width} ${scheme}`);
      await page.keyboard.press("Escape");

      // Agen: an enrolled (offline) agent, the token dialog with a fresh token, and the revoke confirmation
      await page.goto("/agen");
      await expect(page.getByRole("article", { name: "Agen Tata Letak" })).toBeVisible();
      expectClean(await audit(page), `agen daftar ${width} ${scheme}`);
      await page.getByRole("button", { name: "Buat token pendaftaran" }).click();
      await page
        .getByRole("dialog", { name: "Token pendaftaran agen" })
        .getByRole("button", { name: "Buat token" })
        .click();
      await expect(page.getByTestId("enroll-token")).toBeVisible();
      expectClean(await audit(page), `agen token ${width} ${scheme}`);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Cabut agen Agen Tata Letak" }).click();
      await expect(page.getByRole("dialog", { name: "Cabut agen?" })).toBeVisible();
      expectClean(await audit(page), `agen cabut ${width} ${scheme}`);
      await page.keyboard.press("Escape");

      for (const [who, label] of [
        [operator, "operator"],
        [viewer, "penonton"],
      ] as const) {
        await page.waitForLoadState("networkidle");
        await context.clearCookies();
        await signInAs(context, who);
        await page.goto("/akses");
        await expect(page.getByRole("heading", { name: "Akses kamera" })).toBeVisible();
        await expect(page.getByRole("table")).toBeVisible();
        expectClean(await audit(page), `akses ${label} ${width} ${scheme}`);
      }

      // operator with view-only on the camera: explained state in the snapshot stage
      await page.waitForLoadState("networkidle");
      await context.clearCookies();
      await signInAs(context, operator);
      await page.goto(`/perangkat?d=${device.id}&c=${cameras[1]?.id}`);
      await expect(page.getByText("Akses Anda ke kamera ini hanya melihat.")).toBeVisible();
      expectClean(await audit(page), `snapshot tanpa akses ${width} ${scheme}`);

      expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
      await mock.stop();
      await context.close();
    });
  }
}
