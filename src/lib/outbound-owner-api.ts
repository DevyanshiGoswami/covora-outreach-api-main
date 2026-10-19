import "server-only";
import { z } from "zod";
import {
  ApiError,
  checkDatabaseError,
  createOutboundHandler,
  json,
  readJson,
  type OutboundApiConfig,
} from "./outbound-http";
import { createSupabaseAdminClient } from "./supabase/admin";

const token = z.string().regex(/^[a-f0-9]{64}$/);
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const tokenInput = z.strictObject({ token });
const idInput = z.strictObject({ invitationId: z.uuid() });
const createdSchema = z.tuple([
  z.object({ invitation_id: z.uuid(), token, expires_at: z.string() }),
]);
const ownerList = z.object({
  userId: z.uuid(),
  canRemoveOwners: z.boolean().default(false),
  owners: z.array(
    z.object({
      userId: z.uuid(),
      email: z.string(),
      state: z.enum(["active", "suspended", "revoked"]),
      version: z.number().int().positive(),
    }),
  ),
  invitations: z.array(
    z.object({
      id: z.uuid(),
      email: z.string(),
      status: z.enum(["pending", "accepted", "revoked", "expired"]),
      expiresAt: z.string(),
    }),
  ),
});
export type OwnerApiConfig = OutboundApiConfig & {
  admin?: ReturnType<typeof createSupabaseAdminClient>;
};
async function input<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (new URL(request.url).search) throw new ApiError(400);
  const value = schema.safeParse(await readJson(request));
  if (!value.success) throw new ApiError(400);
  return value.data;
}
export function createOwnerHandlers(config?: OwnerApiConfig) {
  const handle = createOutboundHandler(config, {
    400: "Check the request and refresh current owner access.",
    401: "Sign in to continue.",
    403: "Owner access or invitation unavailable for this account.",
    500: "Owner access could not be confirmed. Please try again.",
  });
  return {
    list: handle(async (request, client) => {
      if (new URL(request.url).search) throw new ApiError(400);
      const result = await client.rpc("list_outreach_owners");
      checkDatabaseError(result.error);
      return json(ownerList.parse(result.data));
    }),
    invite: handle(async (request, client) => {
      const value = await input(request, z.strictObject({ email }));
      const result = await client.rpc("create_outreach_owner_invitation", {
        p_email: value.email,
      });
      checkDatabaseError(result.error);
      const created = createdSchema.parse(result.data)[0];
      // Only new Auth identities receive activation links. Never generate recovery
      // or magic links for an existing identity, even when an owner requests it.
      let loginToken: string | null = null;
      let accountStatus: "new" | "existing" | "unavailable" = "unavailable";
      try {
        const link = await (
          config?.admin ?? createSupabaseAdminClient()
        ).auth.admin.generateLink({ type: "invite", email: value.email });
        if (!link.error && link.data.properties?.hashed_token) {
          loginToken = link.data.properties.hashed_token;
          accountStatus = "new";
        } else if (
          ["email_exists", "user_already_exists"].includes(
            link.error?.code ?? "",
          )
        )
          accountStatus = "existing";
      } catch {
        /* The invitation exists; expose no privileged service diagnostics. */
      }
      return json({
        invitationId: created.invitation_id,
        token: created.token,
        expiresAt: created.expires_at,
        loginToken,
        accountStatus,
      });
    }),
    inspect: handle(async (request, client) => {
      const value = await input(request, tokenInput);
      const result = await client.rpc("inspect_outreach_owner_invitation", {
        p_token: value.token,
      });
      checkDatabaseError(result.error);
      return json(
        z
          .object({
            email: z.string(),
            status: z.enum(["pending", "accepted"]),
            expiresAt: z.string(),
          })
          .parse(result.data),
      );
    }),
    accept: handle(async (request, client) => {
      const value = await input(request, tokenInput);
      const result = await client.rpc("accept_outreach_owner_invitation", {
        p_token: value.token,
      });
      checkDatabaseError(result.error);
      return json({ ok: true });
    }),
    revokeInvitation: handle(async (request, client) => {
      const value = await input(request, idInput);
      const result = await client.rpc("revoke_outreach_owner_invitation", {
        p_id: value.invitationId,
      });
      checkDatabaseError(result.error);
      return json({ ok: true });
    }),
    revokeOwner: handle(async (request, client) => {
      const value = await input(
        request,
        z.strictObject({
          userId: z.uuid(),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER),
        }),
      );
      const result = await client.rpc("revoke_outreach_owner", {
        p_user_id: value.userId,
        p_expected_version: value.expectedVersion,
      });
      checkDatabaseError(result.error);
      return json({ ok: true });
    }),
  };
}
