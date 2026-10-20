import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, migratedDb } from "./pglite";

/** D40: user_settings.analytics_enabled (opt-out, on by default) and RLS on it. PGlite only. */
const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b1";

let db: PGlite;
const setting = async (uid: string) =>
  (await db.query<{ analytics_enabled: boolean }>(`select analytics_enabled from user_settings where user_id = '${uid}'`)).rows[0]
    ?.analytics_enabled;

beforeAll(async () => {
  db = await migratedDb();
  await db.exec(`insert into auth.users values ('${A}', 'a@example.com', '{}'), ('${B}', 'b@example.com', '{}')`);
});

describe("user_settings.analytics_enabled (D40)", () => {
  it("is boolean not null default true, and new sign-ups get true", async () => {
    const col = await db.query<{ data_type: string; is_nullable: string; column_default: string }>(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'user_settings' and column_name = 'analytics_enabled'`,
    );
    expect(col.rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "true" }]);
    expect(await setting(A)).toBe(true);
    expect(await setting(B)).toBe(true);
    await expect(db.exec(`update user_settings set analytics_enabled = null where user_id = '${A}'`)).rejects.toThrow(/null/);
  });

  it("a user reads only their own row", async () => {
    const rows = await asUser(db, A, () => db.query<{ user_id: string }>(`select user_id, analytics_enabled from user_settings`));
    expect(rows.rows.map((r) => r.user_id)).toEqual([A]);
  });

  it("a user can turn their own analytics off and on", async () => {
    const off = await asUser(db, A, () => db.query(`update user_settings set analytics_enabled = false where user_id = '${A}'`));
    expect(off.affectedRows).toBe(1);
    expect(await setting(A)).toBe(false);
    await asUser(db, A, () => db.query(`update user_settings set analytics_enabled = true where user_id = '${A}'`));
    expect(await setting(A)).toBe(true);
  });

  it("a user cannot change another user's setting, take over their row, or insert/delete rows", async () => {
    const other = await asUser(db, A, () => db.query(`update user_settings set analytics_enabled = false where user_id = '${B}'`));
    expect(other.affectedRows).toBe(0);
    expect(await setting(B)).toBe(true);

    await expect(asUser(db, A, () => db.exec(`update user_settings set user_id = '${B}' where user_id = '${A}'`))).rejects.toThrow();
    expect(await setting(A)).toBe(true);

    await expect(
      asUser(db, A, () => db.exec(`insert into user_settings (user_id, analytics_enabled) values ('${B}', false)`)),
    ).rejects.toThrow();
    expect((await asUser(db, A, () => db.query(`delete from user_settings`))).affectedRows).toBe(0);
    expect(await setting(B)).toBe(true);
  });

  it("an anonymous session sees no rows", async () => {
    const rows = await asUser(db, "", () => db.query(`select * from user_settings`));
    expect(rows.rows).toEqual([]);
  });
});
