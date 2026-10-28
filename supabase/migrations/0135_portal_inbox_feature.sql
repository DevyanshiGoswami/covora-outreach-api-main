-- Workspace opt-in for the portal-only Inbox read by outreach_private.portal_inbox_only.
alter table public.client_features drop constraint client_features_feature_check;
alter table public.client_features add constraint client_features_feature_check check(feature in ('outreach_app','outreach_portal_inbox'));
