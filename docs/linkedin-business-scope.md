# LinkedIn campaign ownership boundary

Migration `0099_outreach_campaign_channels.sql` adds a private campaign channel to existing explicit business assignments. Existing rows default to `email`; a future LinkedIn assignment must be deliberately provisioned with `channel='linkedin'`, the verified numeric HeyReach campaign ID and the intended tenant. No campaign discovery, automatic assignment, campaign creation or campaign launch is implemented. There are currently no approved LinkedIn campaigns, so the configured sender can be ready for sync/replies while its inbox remains empty.

Campaign IDs, clients and channels cannot be repurposed in place. LinkedIn IDs must be canonical positive integers within JavaScript's safe integer range. The existing neutral email campaign, step, daily, lead and message projections filter to email assignments without changing any frontend column shapes. LinkedIn conversations use the private campaign FK; this FK never exposes the provider ID through the frontend DTO.

## Import and reply authorization

The worker loads only the sender tenant's explicit LinkedIn assignments. An empty assignment list makes no provider history request. Nonempty requests include both sender and campaign filters. The adapter validates every returned row's sender/profile and campaign before saving any row, rejecting the whole page for personal, unmatched or foreign business conversations. Group conversations are not imported. Each SQL import additionally requires the exact same-tenant local campaign ID, observed remote campaign ID and captured sender/workspace versions; it also checks the current feature and synchronization gate. Failed or stale writes never advance the cursor.

Changing the campaign scope resets sender cursors and increments the sender version, fencing cached pages and pending replies. The reset trigger runs before campaign FK cascades and takes the existing client fence before rewriting senders. It skips a tenant already being cascade-deleted. This preserves campaign → client → sender order and prevents campaign withdrawal from deadlocking against dispatch. Removing a campaign removes its mirror through the existing FK contract and cancels subsequent dispatch attempts.

User-triggered LinkedIn replies require a campaign ID in the private claimed context. Preflight checks the authenticated sender, connection status, exact conversation/recipient and unchanged latest fingerprint. It also proves the exact thread belongs to that campaign through a bounded V3 lookup filtered to the sender, campaign and recipient profile. SQL then rechecks authority, ownership, campaign scope, latest message and binding versions before dispatch. Existing one-attempt delivery handling and uncertain-outcome behavior remain unchanged. Tests dispatch only through simulated transport; no real prospect messages were sent.

## Verified provider contracts

The [official API reference](https://documenter.getpostman.com/view/23808049/2sA2xb5F75#b11a6379-341c-4368-ba96-b7f68d5d1bec), linked from the [provider's help center](https://help.heyreach.io/en/articles/11657798-how-to-add-leads-to-campaigns), was checked in the browser on October 5, 2026. V3 documents `filters.linkedInAccountIds`, `filters.campaignIds`, `leadProfileUrl`, cursor pagination and omission of `items[].campaignId` for conversations outside campaigns. Its bounded filter is therefore required even when a personal sender is connected.

The documented [GetChatroom sample](https://documenter.getpostman.com/view/23808049/2sA2xb5F75#4476f6de-4085-4418-98fb-61661149696a) does not include campaign ownership. Inferring permission from that sample or the account alone would be unsafe; the additional V3 proof establishes the explicit mapping. A missing proof or history mismatch fails closed. No account or campaign API call was made while implementing these changes.

## Activation order

Apply 0099 only to the independently provisioned outbound project, then deploy the matching backend code before activating its schedules and gates. The old LinkedIn import RPC signature is removed so stale worker deployments fail closed. Email workers must select `channel='email'`; LinkedIn workers select `channel='linkedin'`.

The verified primary LinkedIn workspace/sender remain unchanged. Enable their reviewed sync/reply gates through the root rollout only. Until a real campaign has been verified as Covora business outreach and explicitly assigned, no LinkedIn history is admitted. DioWave and unmatched campaigns must not be assigned. Notifications remain disabled, and activation does not send a message or launch a campaign.
