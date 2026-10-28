# EPM change-request comments

The Comments tab stores real change requests and discussion in the dedicated outbound database, including when EPM's activity presentation is a preview. It does not enable preview outreach, send email, dispatch notifications, contact prospects, or call external providers.

## Access and rollout

Migration `0121_outreach_comments.sql` creates default-off, service-only settings constrained to EPM workspace `26a2cffb-47f4-4231-9195-b4f772751c6d`. It enables no workspace automatically. An authorized rollout must apply the migration and explicitly insert/update that workspace's `outreach_comment_settings.enabled`. Existing `outreach_app` access remains required. Turning comments off preserves stored requests and messages while denying detail/mutation access and returning an empty disabled list to authorized workspace users.

All active EPM roles can read. Client administrators, client members, assigned operators and explicit agency owners can create requests and reply. Only assigned operators and agency owners can change status. Viewers cannot mutate. Foreign clients, unassigned users, suspended/revoked memberships and a disabled outbound feature fail at the SQL boundary. Replays recheck current authority before returning a receipt.

The database derives the actor from `auth.uid()` and snapshots their existing profile display name, with a neutral fallback for an absent name. No client can supply an author identity. User IDs, command hashes and private settings stay out of DTOs. Raw tables have no authenticated/anonymous grants; guarded RPCs provide the only client access. User deletion preserves discussion text and its display-name snapshot.

## HTTP contract

All routes require the current user's bearer token and return `Cache-Control: no-store`. Text is plain text. Titles are 1–120 JavaScript UTF-16 units and bodies/replies 1–5,000, with the explicit ECMAScript whitespace set trimmed. The same length and whitespace rules apply to direct database RPC calls. Empty text is invalid. The comments adapter bounds JSON to 32 KiB to support multibyte text without changing other APIs' default 8 KiB limit. Unknown/duplicate query parameters and extra mutation fields are rejected.

| Method and route | Input | Output |
| --- | --- | --- |
| `GET /api/outbound/comments` | `clientId`; optional `status=all/open/in_progress/resolved`, `offset=0` | `{clientId,enabled,permissions:{canComment,canManage},requests,hasMore}` |
| `POST /api/outbound/comments` | `{clientId,commandId,title,body}` | `{requestId}` |
| `GET /api/outbound/comments/{id}` | `clientId`; optional `offset=0` | `{clientId,request:{...summary,body},messages,hasMore}` |
| `POST /api/outbound/comments/{id}/replies` | `{clientId,commandId,body}` | `{requestId}` |
| `PATCH /api/outbound/comments/{id}` | `{clientId,expectedVersion,status}` | `{ok:true}` |

A request summary is `{id,clientId,title,status,version,createdAt,updatedAt,authorName,replyCount}`. A reply is `{id,requestId,clientId,body,authorName,createdAt}`. The initial request body is separate from replies; `replyCount` counts replies only. Both list and replies are fixed to 25 items; offsets range from 0 to 100,000. Request order is immutable creation time descending then ID, and replies are chronological then ID. Replies/status changes update displayed latest activity without moving requests between pages. New requests and changed status-filter membership can still affect offset pages; reload the first page to refresh the list. No snapshot-consistent pagination is promised.

Request creation and replies require UUID command IDs, scoped to the authenticated author and client. Concurrent identical commands commit once and return the original request ID. Reusing an ID for different content, another thread or another command kind returns HTTP 409. Retain the original ID and body when a response is lost; do not automatically generate a new command for a retry.

Replies and status updates increment the request version and latest activity. Status edits require the current version; a stale edit returns 409 and must be reviewed against refreshed state. Status changes are not automatically retried. All three statuses can transition to another; replying to a resolved request preserves its status until an operator explicitly changes it. No editing/deletion, attachments, mentions or notification system is included.

Invalid requests return 400, invalid sessions 401, unavailable workspace/thread/permission 403, conflicts 409 and sanitized internal failures 500. Missing and inaccessible threads share the same denial. RPC responses are schema-checked and tenant/thread lineage-checked before being returned, with undeclared database fields removed.

## Verification

Meaningful API tests cover bearer binding, strict payloads and pagination, multibyte text, author-spoof rejection, output lineage, feature-off leakage, conflicts and neutral errors. Real isolated database tests cover all roles, EPM-only/default-off settings, preview collaboration, direct-table denial, foreign tenants, revocation, feature changes, concurrent idempotency and status conflicts, activity ordering, pagination, and text/status limits.

October 21 local verification uses a new stack, `Covora_EPM_Comments_20261021`, API/Auth port 61221 and database port 61222. Existing stacks are not reset or modified. The verification mirror changes only local stack/runtime addresses and contains private synthetic test configuration. Generated schema types come from that isolated schema. Dated logs and rollout/browser results belong in the task's verification receipt; a passing build does not establish production deployment or feature enablement.
