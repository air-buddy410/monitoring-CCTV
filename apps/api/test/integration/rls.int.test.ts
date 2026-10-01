import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";

/**
 * Proves isolation at the database layer, independent of API code:
 * the application role cannot bypass RLS and a missing tenant context yields nothing.
 */
describe("PostgreSQL RLS", () => {
  let app: pg.Pool;
  let admin: pg.Pool;
  const orgA = `org_${randomUUID()}`;
  const orgB = `org_${randomUUID()}`;
  const siteA = `site_${randomUUID()}`;
  const devA = `dev_${randomUUID()}`;

  beforeAll(async () => {
    const urls = inject("dbUrls");
    app = new pg.Pool({ connectionString: urls.app, max: 2 });
    admin = new pg.Pool({ connectionString: urls.admin, max: 2 });
    for (const id of [orgA, orgB]) {
      await admin.query(
        `insert into "organization" (id, name, slug, created_at) values ($1,$2,$3, now())`,
        [id, id, id],
      );
    }
    await admin.query(`insert into site (id, organization_id, name) values ($1,$2,'s')`, [siteA, orgA]);
    await admin.query(
      `insert into device (id, organization_id, site_id, name, kind, host, port, adapter_id, status)
       values ($1,$2,$3,'d','ipc','127.0.0.1',80,'onvif-generic','online')`,
      [devA, orgA, siteA],
    );
    await admin.query(
      `insert into audit_log (id, organization_id, action, target) values ($1,$2,'test.action',$3)`,
      [`aud_${randomUUID()}`, orgA, devA],
    );
  });
  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  async function asTenant<T>(orgId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await app.connect();
    try {
      await c.query("begin");
      if (orgId !== null) await c.query("select set_config('app.org_id', $1, true)", [orgId]);
      const r = await fn(c);
      await c.query("rollback");
      return r;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  it("application role is not superuser and does not bypass RLS", async () => {
    const r = await app.query(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("every tenant table has RLS enabled and forced", async () => {
    const r = await admin.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relname = any($1) and relkind = 'r'`,
      [["site", "device", "device_secret", "camera", "audit_log"]],
    );
    expect(r.rows).toHaveLength(5);
    for (const row of r.rows) {
      expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("no tenant context => zero rows", async () => {
    for (const t of ["site", "device", "audit_log"]) {
      const r = await asTenant(null, (c) => c.query(`select * from ${t}`));
      expect(r.rowCount, t).toBe(0);
    }
  });

  it("empty-string tenant context => zero rows", async () => {
    const r = await asTenant("", (c) => c.query("select * from device"));
    expect(r.rowCount).toBe(0);
  });

  it("other tenant context => zero rows; owning tenant context => rows", async () => {
    expect((await asTenant(orgB, (c) => c.query("select * from device"))).rowCount).toBe(0);
    expect((await asTenant(orgA, (c) => c.query("select * from device"))).rowCount).toBe(1);
  });

  it("cannot insert a row for another tenant (WITH CHECK)", async () => {
    await expect(
      asTenant(orgB, (c) =>
        c.query(`insert into site (id, organization_id, name) values ($1,$2,'evil')`, [
          `site_${randomUUID()}`,
          orgA,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update or delete another tenant's rows (0 rows affected)", async () => {
    const up = await asTenant(orgB, (c) => c.query(`update device set name = 'pwned' where id = $1`, [devA]));
    expect(up.rowCount).toBe(0);
    const del = await asTenant(orgB, (c) => c.query(`delete from device where id = $1`, [devA]));
    expect(del.rowCount).toBe(0);
    const still = await admin.query("select name from device where id = $1", [devA]);
    expect(still.rows[0].name).toBe("d");
  });

  it("cannot move a row to another tenant via UPDATE", async () => {
    await expect(
      asTenant(orgA, (c) => c.query(`update device set organization_id = $1 where id = $2`, [orgB, devA])),
    ).rejects.toThrow(/row-level security/i);
  });

  it("audit_log is append-only for the application role", async () => {
    await expect(asTenant(orgA, (c) => c.query(`update audit_log set action = 'x'`))).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asTenant(orgA, (c) => c.query(`delete from audit_log`))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("audit_log is append-only even for the table owner (trigger)", async () => {
    const owner = new pg.Pool({ connectionString: inject("dbUrls").owner, max: 1 });
    try {
      await expect(owner.query(`update audit_log set action = 'x'`)).rejects.toThrow(/append-only/i);
      await expect(owner.query(`delete from audit_log`)).rejects.toThrow(/append-only/i);
    } finally {
      await owner.end();
    }
  });
});
