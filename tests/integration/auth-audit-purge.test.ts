import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { migratedDb } from "./pglite";

/** The matching rules of public.auth_audit_purge(), on synthetic audit entries with the real payload shapes. */

const NIL = "00000000-0000-0000-0000-000000000000";
const GONE = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const EMAIL = "gone@example.com";

const login = (id: string, email: string) => ({ action: "login", actor_id: id, actor_username: email, actor_via_sso: false, log_type: "account", traits: { provider_type: "magiclink" } });
const deleted = (id: string, email: string) => ({ action: "user_deleted", actor_id: NIL, actor_username: "service_role", actor_via_sso: false, log_type: "team", traits: { user_email: email, user_id: id, user_phone: "" } });

describe("auth_audit_purge", () => {
  let db: PGlite;

  async function entry(payload: unknown) {
    await db.query("insert into auth.audit_log_entries (payload) values ($1::json)", [JSON.stringify(payload)]);
  }
  const left = async () => (await db.query<{ a: string }>("select payload->>'action' as a from auth.audit_log_entries order by 1")).rows.map((r) => r.a);
  const purge = async (id: string, email: string | null) =>
    (await db.query<{ r: { deleted: number; remaining: number } }>("select public.auth_audit_purge($1::uuid, $2) as r", [id, email])).rows[0]!.r;
  const pendingRows = async () => (await db.query<{ user_id: string; email: string | null }>("select user_id, email from private.auth_audit_purges order by user_id")).rows;

  beforeEach(async () => {
    db = await migratedDb();
  });

  it("removes login and user_deleted entries, and leaves other users' and service-role entries", async () => {
    await entry(login(GONE, EMAIL));
    await entry(deleted(GONE, EMAIL));
    await entry({ ...login(OTHER, "other@example.com"), action: "other_login" });
    await entry({ ...deleted(OTHER, "other@example.com"), action: "other_deleted" });
    await entry({ action: "system", actor_id: NIL, actor_username: "service_role", traits: {} });
    expect(await purge(GONE, EMAIL)).toEqual({ deleted: 2, remaining: 0 });
    expect(await left()).toEqual(["other_deleted", "other_login", "system"]);
  });

  it("matches the email or id alone, in any case, and in any field or depth", async () => {
    await entry({ action: "a", actor_id: OTHER, actor_username: "GONE@Example.COM" });
    await entry({ action: "b", actor_id: GONE.toUpperCase(), actor_username: "x@example.com" });
    await entry({ action: "c", traits: { nested: [{ recipient: EMAIL }] } });
    expect(await purge(GONE, EMAIL)).toEqual({ deleted: 3, remaining: 0 });
  });

  it("whole values only: a longer address or a sentence holding the email isn't this user", async () => {
    await entry({ action: "longer", actor_username: `a${EMAIL}` });
    await entry({ action: "suffix", actor_username: `${EMAIL}.org` });
    await entry({ action: "id_prefix", actor_id: `${GONE}0` });
    expect(await purge(GONE, EMAIL)).toEqual({ deleted: 0, remaining: 0 });
    expect(await left()).toHaveLength(3);
  });

  it("with no email only the id matches, and JSON nulls don't", async () => {
    await entry(login(GONE, EMAIL));
    await entry({ action: "email_only", actor_username: EMAIL });
    await entry({ action: "nulls", actor_id: null, actor_username: null });
    expect(await purge(GONE, null)).toEqual({ deleted: 1, remaining: 0 });
    expect(await left()).toEqual(["email_only", "nulls"]);
  });

  it.each([
    ["the nil id", NIL, EMAIL, "invalid user"],
    ["a null id", null, EMAIL, "invalid user"],
    ["the service_role actor name", GONE, "service_role", "invalid email"],
    ["a blank email", GONE, "", "invalid email"],
  ])("refuses %s, which would match other users' entries", async (_, id, email, message) => {
    await entry({ action: "system", actor_id: NIL, actor_username: "service_role" });
    await expect(db.query("select public.auth_audit_purge($1::uuid, $2)", [id, email])).rejects.toThrow(message);
    expect(await left()).toEqual(["system"]);
  });

  it("refuses while the user exists", async () => {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [GONE, EMAIL]);
    await entry(login(GONE, EMAIL));
    await expect(purge(GONE, EMAIL)).rejects.toThrow("user still exists");
    expect(await left()).toEqual(["login"]);
  });

  it("someone new with that email keeps their entries; the deleted user's still go, by id", async () => {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [OTHER, EMAIL]);
    await entry(login(GONE, EMAIL));
    await entry({ ...login(OTHER, EMAIL), action: "new_login" });
    expect(await purge(GONE, EMAIL)).toEqual({ deleted: 1, remaining: 0 });
    expect(await left()).toEqual(["new_login"]);
  });

  it("prepare records the email, deletes nothing, and a successful purge clears the record", async () => {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [GONE, EMAIL]);
    await entry(login(GONE, EMAIL));
    await db.query("select public.auth_audit_purge_prepare($1::uuid, null)", [GONE]);
    expect(await pendingRows()).toEqual([{ user_id: GONE, email: EMAIL }]);
    expect(await left()).toEqual(["login"]);
    await db.query("delete from auth.users where id = $1", [GONE]);
    expect(await purge(GONE, null)).toEqual({ deleted: 1, remaining: 0 });
    expect(await pendingRows()).toEqual([]);
  });

  it("pending: finishes users who are gone, waits for a recent one who exists, drops an old one who exists", async () => {
    const RECENT = "cccccccc-0000-4000-8000-000000000003";
    await db.query("insert into auth.users (id, email) values ($1, 'recent@example.com'), ($2, 'kept@example.com')", [RECENT, OTHER]);
    await db.query("insert into private.auth_audit_purges (user_id, email, created_at) values ($1, $2, now()), ($3, 'recent@example.com', now()), ($4, 'kept@example.com', now() - interval '2 days')", [GONE, EMAIL, RECENT, OTHER]);
    await entry(deleted(GONE, EMAIL));
    await entry({ ...login(RECENT, "recent@example.com"), action: "recent_login" });
    await entry({ ...login(OTHER, "kept@example.com"), action: "kept_login" });
    expect((await db.query<{ r: unknown }>("select public.auth_audit_purge_pending() as r")).rows[0]!.r).toEqual({ purged: 1, pending: 0 });
    expect(await left()).toEqual(["kept_login", "recent_login"]);
    expect((await pendingRows()).map((r) => r.user_id)).toEqual([RECENT]);
  });
});
