# Local owner sessions need a separate client boundary

An agency owner intentionally sees every enabled client through existing RLS.
Reusing the owner's ordinary bearer locally and filtering the frontend directory
would not isolate other clients. A developer-controlled request could bypass it.

The hosted gateway therefore accepts an opaque, expiring delegation limited to
Covora. It preserves existing user verification, RLS, roles, reply fencing and
idempotency after separately authorizing the requested client/resource. Neutral
view access is a small allowlist, not a generic SQL/PostgREST proxy. Owner context
and integration metadata need explicit projection because they are agency-wide.

The initial mailbox-grant proposal was replaced after the user clarified that
existing agency owners should use the normal portal with Covora as its only
client. This implementation uses the existing integration configuration; it
introduces no separate test integration or per-developer mailbox grant system.

Connected development changes live Covora data. Isolated local database/provider
fixtures remain the way to exercise backend changes without live side effects.
The gateway must be deployed and its Covora client ID reviewed before activation.
