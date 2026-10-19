import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { adminClient, anonClient } from "../helpers/admin.ts";
import { createTenant, createUser } from "../helpers/tenants.ts";
import {
  grantOutreachMembership,
  grantOutreachOwner,
} from "../helpers/outreach.ts";
import { loadTestEnv } from "../helpers/env.ts";
import { createOwnerHandlers } from "../../src/lib/outbound-owner-api.ts";
const admin = adminClient();
async function fixture(t: TestContext) {
  const tenant = await createTenant(null, { features: ["outreach_app"] });
  const owner = await createUser();
  await grantOutreachOwner(owner.user.id);
  await grantOutreachMembership(
    tenant.user.id,
    tenant.client.id,
    "client_admin",
  );
  const people = [owner];
  t.after(async () => {
    await tenant.cleanup();
    for (const p of people)
      assert.ifError((await admin.auth.admin.deleteUser(p.user.id)).error);
  });
  async function person(role?: "operator" | "client_member" | "client_viewer") {
    const u = await createUser();
    people.push(u);
    if (role) await grantOutreachMembership(u.user.id, tenant.client.id, role);
    return u;
  }
  return { tenant, owner, person };
}
async function invite(
  session: Awaited<ReturnType<typeof createUser>>["session"],
  email: string,
) {
  const r = await session.rpc("create_outreach_owner_invitation", {
    p_email: email,
  });
  assert.ifError(r.error);
  return r.data![0];
}
test("only explicit active owners can list/create/revoke owners, independently of client admin roles", async (t) => {
  const f = await fixture(t);
  const target = await f.person();
  const i = await invite(f.owner.session, target.user.email);
  for (const s of [
    f.tenant.supabase,
    (await f.person("operator")).session,
    (await f.person("client_member")).session,
    (await f.person("client_viewer")).session,
    target.session,
    anonClient(),
  ]) {
    assert.ok((await s.rpc("list_outreach_owners")).error);
    assert.ok(
      (
        await s.rpc("create_outreach_owner_invitation", {
          p_email: target.user.email,
        })
      ).error,
    );
    assert.ok(
      (
        await s.rpc("revoke_outreach_owner_invitation", {
          p_id: i.invitation_id,
        })
      ).error,
    );
    assert.ok(
      (
        await s.rpc("revoke_outreach_owner", {
          p_user_id: f.owner.user.id,
          p_expected_version: 1,
        })
      ).error,
    );
    assert.ok((await s.from("outreach_owner_invitations").select("*")).error);
  }
  const list = await f.owner.session.rpc("list_outreach_owners");
  assert.ifError(list.error);
  assert.equal(JSON.stringify(list.data).includes(i.token), false);
  const stored = await admin
    .from("outreach_owner_invitations")
    .select("*")
    .eq("id", i.invitation_id)
    .single();
  assert.equal(
    stored.data?.token_hash,
    createHash("sha256").update(i.token).digest("hex"),
  );
});
test("email-bound invitations grant global ownership once and preserve existing passwords", async (t) => {
  const f = await fixture(t);
  const u = await f.person();
  const wrong = await f.person();
  const i = await invite(f.owner.session, ` ${u.user.email.toUpperCase()} `);
  assert.equal(
    (
      await wrong.session.rpc("inspect_outreach_owner_invitation", {
        p_token: i.token,
      })
    ).error?.code,
    "42501",
  );
  assert.equal(
    (
      await wrong.session.rpc("accept_outreach_owner_invitation", {
        p_token: i.token,
      })
    ).error?.code,
    "42501",
  );
  assert.ifError(
    (
      await u.session.rpc("inspect_outreach_owner_invitation", {
        p_token: i.token,
      })
    ).error,
  );
  const accepted = await Promise.all(
    Array.from({ length: 5 }, () =>
      u.session.rpc("accept_outreach_owner_invitation", { p_token: i.token }),
    ),
  );
  for (const r of accepted) assert.ifError(r.error);
  const m = await admin
    .from("outreach_agency_memberships")
    .select("state,version")
    .eq("user_id", u.user.id)
    .single();
  assert.deepEqual(m.data, { state: "active", version: 1 });
  const workspace = await u.session
    .from("client_outreach_workspaces")
    .select("client_id,role")
    .eq("client_id", f.tenant.client.id)
    .single();
  assert.equal(workspace.data?.role, "agency_owner");
  assert.ifError(
    (
      await anonClient().auth.signInWithPassword({
        email: u.user.email,
        password: u.user.password,
      })
    ).error,
  );
  const audit = await admin
    .from("outreach_owner_audit")
    .select("*")
    .eq("subject_id", i.invitation_id)
    .eq("event_type", "accepted");
  assert.equal(audit.data?.length, 1);
  assert.equal(JSON.stringify(audit.data).includes(i.token), false);
});
test("reissue, expiry, revocation and stale inviter version prevent acceptance", async (t) => {
  const f = await fixture(t);
  const u = await f.person();
  const first = await invite(f.owner.session, u.user.email);
  const second = await invite(f.owner.session, u.user.email);
  assert.equal(
    (
      await u.session.rpc("accept_outreach_owner_invitation", {
        p_token: first.token,
      })
    ).error?.code,
    "42501",
  );
  await admin
    .from("outreach_owner_invitations")
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq("id", second.invitation_id);
  assert.equal(
    (
      await u.session.rpc("accept_outreach_owner_invitation", {
        p_token: second.token,
      })
    ).error?.code,
    "42501",
  );
  const third = await invite(f.owner.session, u.user.email);
  assert.ifError(
    (
      await f.owner.session.rpc("revoke_outreach_owner_invitation", {
        p_id: third.invitation_id,
      })
    ).error,
  );
  assert.equal(
    (
      await u.session.rpc("accept_outreach_owner_invitation", {
        p_token: third.token,
      })
    ).error?.code,
    "42501",
  );
  const fourth = await invite(f.owner.session, u.user.email);
  await admin
    .from("outreach_agency_memberships")
    .update({ state: "suspended" })
    .eq("user_id", f.owner.user.id);
  assert.equal(
    (
      await u.session.rpc("accept_outreach_owner_invitation", {
        p_token: fourth.token,
      })
    ).error?.code,
    "42501",
  );
  await admin
    .from("outreach_agency_memberships")
    .update({ state: "active" })
    .eq("user_id", f.owner.user.id);
  assert.equal(
    (
      await u.session.rpc("accept_outreach_owner_invitation", {
        p_token: fourth.token,
      })
    ).error?.code,
    "42501",
  );
});
test("last owner and stale version protection; accepted links cannot restore removed access", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.owner.session.rpc("revoke_outreach_owner", {
        p_user_id: f.owner.user.id,
        p_expected_version: 1,
      })
    ).error?.code,
    "22023",
  );
  const u = await f.person();
  const i = await invite(f.owner.session, u.user.email);
  assert.ifError(
    (
      await u.session.rpc("accept_outreach_owner_invitation", {
        p_token: i.token,
      })
    ).error,
  );
  assert.equal(
    (
      await f.owner.session.rpc("revoke_outreach_owner", {
        p_user_id: u.user.id,
        p_expected_version: 99,
      })
    ).error?.code,
    "22023",
  );
  assert.ifError(
    (
      await f.owner.session.rpc("revoke_outreach_owner", {
        p_user_id: u.user.id,
        p_expected_version: 1,
      })
    ).error,
  );
  assert.ok((await u.session.rpc("list_outreach_owners")).error);
  assert.ok(
    (
      await u.session.rpc("accept_outreach_owner_invitation", {
        p_token: i.token,
      })
    ).error,
  );
  assert.equal(
    (
      await u.session
        .from("client_outreach_workspaces")
        .select("client_id")
        .eq("client_id", f.tenant.client.id)
    ).data?.length,
    0,
  );
});
test("real API new-account activation requires password, and existing accounts never receive a login token", async (t) => {
  const f = await fixture(t);
  const env = loadTestEnv();
  const handlers = createOwnerHandlers({
    url: env.URL,
    anonKey: env.ANON,
    fetch,
    admin,
  });
  const jwt = (await f.owner.session.auth.getSession()).data.session!
    .access_token;
  const email = `new-owner-${randomUUID()}@example.test`;
  const req = (email: string, bearer = jwt) =>
    new Request("http://local.test/api/outbound/owners/invitations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email }),
    });
  const response = await handlers.invite(req(email));
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.accountStatus, "new");
  assert.ok(created.loginToken);
  const session = anonClient();
  const activated = await session.auth.verifyOtp({
    type: "invite",
    token_hash: created.loginToken,
  });
  assert.ifError(activated.error);
  t.after(async () => {
    assert.ifError(
      (await admin.auth.admin.deleteUser(activated.data.user!.id)).error,
    );
  });
  assert.ifError(
    (
      await session.rpc("inspect_outreach_owner_invitation", {
        p_token: created.token,
      })
    ).error,
  );
  assert.equal(
    (
      await session.rpc("accept_outreach_owner_invitation", {
        p_token: created.token,
      })
    ).error?.code,
    "22023",
  );
  const password = `Local-test-${randomUUID()}`;
  assert.ifError((await session.auth.updateUser({ password })).error);
  assert.ifError(
    (
      await session.rpc("accept_outreach_owner_invitation", {
        p_token: created.token,
      })
    ).error,
  );
  assert.ifError(
    (await anonClient().auth.signInWithPassword({ email, password })).error,
  );
  const existing = await f.person();
  const next = await handlers.invite(req(existing.user.email));
  const body = await next.json();
  assert.equal(next.status, 200);
  assert.equal(body.accountStatus, "existing");
  assert.equal(body.loginToken, null);
  assert.ifError(
    (
      await anonClient().auth.signInWithPassword({
        email: existing.user.email,
        password: existing.user.password,
      })
    ).error,
  );
  const deniedToken = (await f.tenant.supabase.auth.getSession()).data.session!
    .access_token;
  assert.equal(
    (
      await handlers.invite(
        req(`denied-${randomUUID()}@example.test`, deniedToken),
      )
    ).status,
    403,
  );
  assert.equal((await handlers.invite(req(email, "invalid"))).status, 401);
});
