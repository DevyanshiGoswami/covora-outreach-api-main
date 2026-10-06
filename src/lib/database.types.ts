export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "client_features": {
                  Row: {
                    "client_id": string,"config": NonNullable<Json>,"enabled": boolean,"feature": string
                  }
                  Insert: {
                    "client_id": string,"config"?: NonNullable<Json>,"enabled"?: boolean,"feature": string
                  }
                  Update: {
                    "client_id"?: string,"config"?: NonNullable<Json>,"enabled"?: boolean,"feature"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "client_features_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                },"clients": {
                  Row: {
                    "created_at": string,"id": string,"name": string,"slug": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"name": string,"slug": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"name"?: string,"slug"?: string
                  }
                  Relationships: [
                    
                  ]
                },"outreach_access_audit": {
                  Row: {
                    "actor_user_id": string,"client_id": string,"created_at": string,"details": NonNullable<Json>,"event_type": string,"id": string,"subject_id": string
                  }
                  Insert: {
                    "actor_user_id": string,"client_id": string,"created_at"?: string,"details"?: NonNullable<Json>,"event_type": string,"id"?: string,"subject_id": string
                  }
                  Update: {
                    "actor_user_id"?: string,"client_id"?: string,"created_at"?: string,"details"?: NonNullable<Json>,"event_type"?: string,"id"?: string,"subject_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"outreach_account_checks": {
                  Row: {
                    "account_id": string,"actor_user_id": string,"authority_stamp": string,"client_id": string,"completed_at": string | null,"created_at": string,"error_code": string | null,"expires_at": string,"id": string,"workspace_version": number
                  }
                  Insert: {
                    "account_id": string,"actor_user_id": string,"authority_stamp": string,"client_id": string,"completed_at"?: string | null,"created_at"?: string,"error_code"?: string | null,"expires_at"?: string,"id"?: string,"workspace_version": number
                  }
                  Update: {
                    "account_id"?: string,"actor_user_id"?: string,"authority_stamp"?: string,"client_id"?: string,"completed_at"?: string | null,"created_at"?: string,"error_code"?: string | null,"expires_at"?: string,"id"?: string,"workspace_version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_account_checks_account_id_client_id_fkey"
      columns: ["account_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_accounts"
      referencedColumns: ["id","client_id"]
    }
                  ]
                },"outreach_account_workspaces": {
                  Row: {
                    "client_id": string,"credential_ref": string,"enabled": boolean,"last_check_started_at": string | null,"remote_workspace_id": string,"updated_at": string,"version": number
                  }
                  Insert: {
                    "client_id": string,"credential_ref": string,"enabled"?: boolean,"last_check_started_at"?: string | null,"remote_workspace_id": string,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "client_id"?: string,"credential_ref"?: string,"enabled"?: boolean,"last_check_started_at"?: string | null,"remote_workspace_id"?: string,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_account_workspaces_client_id_fkey"
      columns: ["client_id"]
isOneToOne: true
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                },"outreach_accounts": {
                  Row: {
                    "check_error": boolean,"client_id": string,"created_at": string,"created_by": string,"current_check_id": string | null,"display_name": string,"email": string,"id": string,"last_attempt_at": string | null,"last_checked_at": string | null,"last_connected_at": string | null,"state": string,"updated_at": string
                  }
                  Insert: {
                    "check_error"?: boolean,"client_id": string,"created_at"?: string,"created_by": string,"current_check_id"?: string | null,"display_name"?: string,"email": string,"id"?: string,"last_attempt_at"?: string | null,"last_checked_at"?: string | null,"last_connected_at"?: string | null,"state"?: string,"updated_at"?: string
                  }
                  Update: {
                    "check_error"?: boolean,"client_id"?: string,"created_at"?: string,"created_by"?: string,"current_check_id"?: string | null,"display_name"?: string,"email"?: string,"id"?: string,"last_attempt_at"?: string | null,"last_checked_at"?: string | null,"last_connected_at"?: string | null,"state"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_accounts_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "outreach_account_workspaces"
      referencedColumns: ["client_id"]
    }
                  ]
                },"outreach_agency_memberships": {
                  Row: {
                    "created_at": string,"role": string,"state": string,"updated_at": string,"user_id": string,"version": number
                  }
                  Insert: {
                    "created_at"?: string,"role"?: string,"state"?: string,"updated_at"?: string,"user_id": string,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"role"?: string,"state"?: string,"updated_at"?: string,"user_id"?: string,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"outreach_campaign_daily": {
                  Row: {
                    "auto_replies": number,"campaign_id": string,"client_id": string,"contacted": number,"day": string,"new_contacted": number,"opportunities": number,"sent": number,"unique_clicks": number,"unique_opened": number,"unique_replies": number
                  }
                  Insert: {
                    "auto_replies"?: number,"campaign_id": string,"client_id": string,"contacted"?: number,"day": string,"new_contacted"?: number,"opportunities"?: number,"sent"?: number,"unique_clicks"?: number,"unique_opened"?: number,"unique_replies"?: number
                  }
                  Update: {
                    "auto_replies"?: number,"campaign_id"?: string,"client_id"?: string,"contacted"?: number,"day"?: string,"new_contacted"?: number,"opportunities"?: number,"sent"?: number,"unique_clicks"?: number,"unique_opened"?: number,"unique_replies"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_campaign_daily_campaign_id_client_id_fkey"
      columns: ["campaign_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_campaigns"
      referencedColumns: ["id","client_id"]
    }
                  ]
                },"outreach_campaign_steps": {
                  Row: {
                    "body_text": string,"campaign_id": string,"client_id": string,"delay_days": number,"stats": NonNullable<Json>,"step": number,"subject": string,"variant": number
                  }
                  Insert: {
                    "body_text"?: string,"campaign_id": string,"client_id": string,"delay_days"?: number,"stats"?: NonNullable<Json>,"step": number,"subject"?: string,"variant"?: number
                  }
                  Update: {
                    "body_text"?: string,"campaign_id"?: string,"client_id"?: string,"delay_days"?: number,"stats"?: NonNullable<Json>,"step"?: number,"subject"?: string,"variant"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_campaign_steps_campaign_id_client_id_fkey"
      columns: ["campaign_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_campaigns"
      referencedColumns: ["id","client_id"]
    }
                  ]
                },"outreach_campaigns": {
                  Row: {
                    "channel": string,"client_id": string,"completed_at": string | null,"created_at": string,"id": string,"messages_purged_at": string | null,"name": string,"provider_campaign_id": string,"schedule": NonNullable<Json>,"status": string,"synced_at": string | null,"totals": NonNullable<Json>,"updated_at": string
                  }
                  Insert: {
                    "channel"?: string,"client_id": string,"completed_at"?: string | null,"created_at"?: string,"id"?: string,"messages_purged_at"?: string | null,"name": string,"provider_campaign_id": string,"schedule"?: NonNullable<Json>,"status"?: string,"synced_at"?: string | null,"totals"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "channel"?: string,"client_id"?: string,"completed_at"?: string | null,"created_at"?: string,"id"?: string,"messages_purged_at"?: string | null,"name"?: string,"provider_campaign_id"?: string,"schedule"?: NonNullable<Json>,"status"?: string,"synced_at"?: string | null,"totals"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_campaigns_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                },"outreach_conversation_messages": {
                  Row: {
                    "body_text": string,"client_id": string,"conversation_id": string,"created_at": string,"direction": string,"id": string,"is_auto_reply": boolean,"remote_fingerprint": string | null,"remote_message_id": string,"sender_label": string,"sent_at": string,"source_message_id": string | null
                  }
                  Insert: {
                    "body_text": string,"client_id": string,"conversation_id": string,"created_at"?: string,"direction": string,"id"?: string,"is_auto_reply"?: boolean,"remote_fingerprint"?: string | null,"remote_message_id": string,"sender_label"?: string,"sent_at": string,"source_message_id"?: string | null
                  }
                  Update: {
                    "body_text"?: string,"client_id"?: string,"conversation_id"?: string,"created_at"?: string,"direction"?: string,"id"?: string,"is_auto_reply"?: boolean,"remote_fingerprint"?: string | null,"remote_message_id"?: string,"sender_label"?: string,"sent_at"?: string,"source_message_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_conversation_messages_conversation_id_client_id_fkey"
      columns: ["conversation_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_conversations"
      referencedColumns: ["id","client_id"]
    },{
      foreignKeyName: "outreach_conversation_messages_source_message_id_fkey"
      columns: ["source_message_id"]
isOneToOne: true
      referencedRelation: "outreach_messages"
      referencedColumns: ["id"]
    }
                  ]
                },"outreach_conversation_reads": {
                  Row: {
                    "client_id": string,"conversation_id": string,"read_at": string,"user_id": string
                  }
                  Insert: {
                    "client_id": string,"conversation_id": string,"read_at"?: string,"user_id": string
                  }
                  Update: {
                    "client_id"?: string,"conversation_id"?: string,"read_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_conversation_reads_conversation_id_client_id_fkey"
      columns: ["conversation_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_conversations"
      referencedColumns: ["id","client_id"]
    }
                  ]
                },"outreach_conversations": {
                  Row: {
                    "campaign_id": string | null,"channel": string,"client_id": string,"contact_address": string,"contact_name": string,"created_at": string,"id": string,"latest_at": string,"latest_message_id": string | null,"owner_user_id": string | null,"remote_conversation_id": string,"sender_address": string,"sender_id": string | null,"source_thread_key": string | null,"status": string,"subject": string,"suppressed": boolean,"synced_at": string | null,"updated_at": string,"version": number
                  }
                  Insert: {
                    "campaign_id"?: string | null,"channel": string,"client_id": string,"contact_address"?: string,"contact_name"?: string,"created_at"?: string,"id"?: string,"latest_at"?: string,"latest_message_id"?: string | null,"owner_user_id"?: string | null,"remote_conversation_id": string,"sender_address"?: string,"sender_id"?: string | null,"source_thread_key"?: string | null,"status"?: string,"subject"?: string,"suppressed"?: boolean,"synced_at"?: string | null,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "campaign_id"?: string | null,"channel"?: string,"client_id"?: string,"contact_address"?: string,"contact_name"?: string,"created_at"?: string,"id"?: string,"latest_at"?: string,"latest_message_id"?: string | null,"owner_user_id"?: string | null,"remote_conversation_id"?: string,"sender_address"?: string,"sender_id"?: string | null,"source_thread_key"?: string | null,"status"?: string,"subject"?: string,"suppressed"?: boolean,"synced_at"?: string | null,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_conversation_latest_message_fk"
      columns: ["latest_message_id","id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_conversation_messages"
      referencedColumns: ["id","conversation_id","client_id"]
    },{
      foreignKeyName: "outreach_conversations_campaign_id_client_id_fkey"
      columns: ["campaign_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_campaigns"
      referencedColumns: ["id","client_id"]
    },{
      foreignKeyName: "outreach_conversations_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "outreach_conversations_sender_id_client_id_channel_fkey"
      columns: ["sender_id","client_id","channel"]
isOneToOne: false
      referencedRelation: "outreach_reply_senders"
      referencedColumns: ["id","client_id","channel"]
    }
                  ]
                },"outreach_fetch_queue": {
                  Row: {
                    "attempt_count": number,"available_at": string,"campaign_id": string,"client_id": string,"completed_at": string | null,"cursor": string | null,"id": string,"last_error": string | null,"lead_email": string,"provider_thread_id": string,"requested_at": string
                  }
                  Insert: {
                    "attempt_count"?: number,"available_at"?: string,"campaign_id": string,"client_id": string,"completed_at"?: string | null,"cursor"?: string | null,"id"?: string,"last_error"?: string | null,"lead_email"?: string,"provider_thread_id"?: string,"requested_at"?: string
                  }
                  Update: {
                    "attempt_count"?: number,"available_at"?: string,"campaign_id"?: string,"client_id"?: string,"completed_at"?: string | null,"cursor"?: string | null,"id"?: string,"last_error"?: string | null,"lead_email"?: string,"provider_thread_id"?: string,"requested_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_fetch_queue_campaign_id_client_id_fkey"
      columns: ["campaign_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_campaigns"
      referencedColumns: ["id","client_id"]
    }
                  ]
                },"outreach_invitations": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"client_id": string,"created_at": string,"email": string,"expires_at": string,"id": string,"invited_by": string,"role": string,"status": string,"target_membership_version": number | null,"target_user_id": string | null,"token_hash": string
                  }
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"client_id": string,"created_at"?: string,"email": string,"expires_at"?: string,"id"?: string,"invited_by": string,"role": string,"status"?: string,"target_membership_version"?: number | null,"target_user_id"?: string | null,"token_hash": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"client_id"?: string,"created_at"?: string,"email"?: string,"expires_at"?: string,"id"?: string,"invited_by"?: string,"role"?: string,"status"?: string,"target_membership_version"?: number | null,"target_user_id"?: string | null,"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_invitations_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                },"outreach_lead_alert_deliveries": {
                  Row: {
                    "claim_token": string,"client_id": string,"created_at": string,"dispatched_at": string | null,"error_code": string | null,"expires_at": string,"finished_at": string | null,"id": string,"lead_count": number,"membership_version": number,"policy_enabled_at": string,"policy_version": number,"recipient_email": string,"status": string,"threshold": number,"user_id": string
                  }
                  Insert: {
                    "claim_token"?: string,"client_id": string,"created_at"?: string,"dispatched_at"?: string | null,"error_code"?: string | null,"expires_at"?: string,"finished_at"?: string | null,"id"?: string,"lead_count": number,"membership_version": number,"policy_enabled_at": string,"policy_version": number,"recipient_email": string,"status"?: string,"threshold": number,"user_id": string
                  }
                  Update: {
                    "claim_token"?: string,"client_id"?: string,"created_at"?: string,"dispatched_at"?: string | null,"error_code"?: string | null,"expires_at"?: string,"finished_at"?: string | null,"id"?: string,"lead_count"?: number,"membership_version"?: number,"policy_enabled_at"?: string,"policy_version"?: number,"recipient_email"?: string,"status"?: string,"threshold"?: number,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_lead_alert_deliveries_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                },"outreach_lead_alert_items": {
                  Row: {
                    "client_id": string,"contact_key": string,"conversation_id": string,"created_at": string,"delivery_id": string,"latest_message_id": string,"user_id": string
                  }
                  Insert: {
                    "client_id": string,"contact_key": string,"conversation_id": string,"created_at"?: string,"delivery_id": string,"latest_message_id": string,"user_id": string
                  }
                  Update: {
                    "client_id"?: string,"contact_key"?: string,"conversation_id"?: string,"created_at"?: string,"delivery_id"?: string,"latest_message_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_lead_alert_items_delivery_id_client_id_user_id_fkey"
      columns: ["delivery_id","client_id","user_id"]
isOneToOne: false
      referencedRelation: "outreach_lead_alert_deliveries"
      referencedColumns: ["id","client_id","user_id"]
    }
                  ]
                },"outreach_lead_alert_policies": {
                  Row: {
                    "client_id": string,"configured_by": string | null,"cooldown_hours": number,"created_at": string,"enabled": boolean,"enabled_at": string | null,"last_scanned_at": string | null,"threshold": number,"updated_at": string,"user_id": string,"version": number
                  }
                  Insert: {
                    "client_id": string,"configured_by"?: string | null,"cooldown_hours"?: number,"created_at"?: string,"enabled"?: boolean,"enabled_at"?: string | null,"last_scanned_at"?: string | null,"threshold"?: number,"updated_at"?: string,"user_id": string,"version"?: number
                  }
                  Update: {
                    "client_id"?: string,"configured_by"?: string | null,"cooldown_hours"?: number,"created_at"?: string,"enabled"?: boolean,"enabled_at"?: string | null,"last_scanned_at"?: string | null,"threshold"?: number,"updated_at"?: string,"user_id"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_lead_alert_policies_user_id_client_id_fkey"
      columns: ["user_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_memberships"
      referencedColumns: ["user_id","client_id"]
    }
                  ]
                },"outreach_leads": {
                  Row: {
                    "campaign_id": string,"client_id": string,"company": string | null,"email": string,"email_verification": string,"first_name": string | null,"id": string,"interest": string | null,"job_title": string | null,"last_activity_at": string | null,"last_name": string | null,"last_step": number | null,"linkedin_url": string | null,"linkedin_verified": boolean | null,"location": string | null,"provider_lead_id": string | null,"reply_count": number,"role_category": string | null,"status": string
                  }
                  Insert: {
                    "campaign_id": string,"client_id": string,"company"?: string | null,"email": string,"email_verification"?: string,"first_name"?: string | null,"id"?: string,"interest"?: string | null,"job_title"?: string | null,"last_activity_at"?: string | null,"last_name"?: string | null,"last_step"?: number | null,"linkedin_url"?: string | null,"linkedin_verified"?: boolean | null,"location"?: string | null,"provider_lead_id"?: string | null,"reply_count"?: number,"role_category"?: string | null,"status"?: string
                  }
                  Update: {
                    "campaign_id"?: string,"client_id"?: string,"company"?: string | null,"email"?: string,"email_verification"?: string,"first_name"?: string | null,"id"?: string,"interest"?: string | null,"job_title"?: string | null,"last_activity_at"?: string | null,"last_name"?: string | null,"last_step"?: number | null,"linkedin_url"?: string | null,"linkedin_verified"?: boolean | null,"location"?: string | null,"provider_lead_id"?: string | null,"reply_count"?: number,"role_category"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_leads_campaign_id_client_id_fkey"
      columns: ["campaign_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_campaigns"
      referencedColumns: ["id","client_id"]
    }
                  ]
                },"outreach_linkedin_activity": {
                  Row: {
                    "client_id": string,"day": string,"meeting_booked": number | null,"replied": number | null,"sent": number,"source": string
                  }
                  Insert: {
                    "client_id": string,"day": string,"meeting_booked"?: number | null,"replied"?: number | null,"sent": number,"source": string
                  }
                  Update: {
                    "client_id"?: string,"day"?: string,"meeting_booked"?: number | null,"replied"?: number | null,"sent"?: number,"source"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_linkedin_activity_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                },"outreach_memberships": {
                  Row: {
                    "client_id": string,"created_at": string,"role": string,"state": string,"updated_at": string,"user_id": string,"version": number
                  }
                  Insert: {
                    "client_id": string,"created_at"?: string,"role": string,"state"?: string,"updated_at"?: string,"user_id": string,"version"?: number
                  }
                  Update: {
                    "client_id"?: string,"created_at"?: string,"role"?: string,"state"?: string,"updated_at"?: string,"user_id"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_memberships_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                },"outreach_messages": {
                  Row: {
                    "body_text": string,"campaign_id": string,"client_id": string,"client_read_at": string | null,"direction": string,"from_email": string,"id": string,"interest": string | null,"is_auto_reply": boolean,"lead_email": string | null,"provider_account": string | null,"provider_email_id": string,"provider_thread_id": string | null,"sent_at": string,"subject": string,"thread_key": string,"to_email": string
                  }
                  Insert: {
                    "body_text"?: string,"campaign_id": string,"client_id": string,"client_read_at"?: string | null,"direction": string,"from_email"?: string,"id"?: string,"interest"?: string | null,"is_auto_reply"?: boolean,"lead_email"?: string | null,"provider_account"?: string | null,"provider_email_id": string,"provider_thread_id"?: string | null,"sent_at": string,"subject"?: string,"thread_key": string,"to_email"?: string
                  }
                  Update: {
                    "body_text"?: string,"campaign_id"?: string,"client_id"?: string,"client_read_at"?: string | null,"direction"?: string,"from_email"?: string,"id"?: string,"interest"?: string | null,"is_auto_reply"?: boolean,"lead_email"?: string | null,"provider_account"?: string | null,"provider_email_id"?: string,"provider_thread_id"?: string | null,"sent_at"?: string,"subject"?: string,"thread_key"?: string,"to_email"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_messages_campaign_id_client_id_fkey"
      columns: ["campaign_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_campaigns"
      referencedColumns: ["id","client_id"]
    }
                  ]
                },"outreach_reply_commands": {
                  Row: {
                    "actor_user_id": string,"authority_stamp": string,"body_text": string,"channel": string,"claim_token": string | null,"client_id": string,"conversation_id": string,"conversation_version": number,"created_at": string,"error_code": string | null,"expires_at": string | null,"id": string,"latest_message_id": string,"remote_message_id": string | null,"sender_id": string,"sender_version": number,"status": string,"updated_at": string,"workspace_version": number
                  }
                  Insert: {
                    "actor_user_id": string,"authority_stamp": string,"body_text": string,"channel": string,"claim_token"?: string | null,"client_id": string,"conversation_id": string,"conversation_version": number,"created_at"?: string,"error_code"?: string | null,"expires_at"?: string | null,"id": string,"latest_message_id": string,"remote_message_id"?: string | null,"sender_id": string,"sender_version": number,"status"?: string,"updated_at"?: string,"workspace_version": number
                  }
                  Update: {
                    "actor_user_id"?: string,"authority_stamp"?: string,"body_text"?: string,"channel"?: string,"claim_token"?: string | null,"client_id"?: string,"conversation_id"?: string,"conversation_version"?: number,"created_at"?: string,"error_code"?: string | null,"expires_at"?: string | null,"id"?: string,"latest_message_id"?: string,"remote_message_id"?: string | null,"sender_id"?: string,"sender_version"?: number,"status"?: string,"updated_at"?: string,"workspace_version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_reply_commands_conversation_id_client_id_fkey"
      columns: ["conversation_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_conversations"
      referencedColumns: ["id","client_id"]
    },{
      foreignKeyName: "outreach_reply_commands_latest_message_id_conversation_id__fkey"
      columns: ["latest_message_id","conversation_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_conversation_messages"
      referencedColumns: ["id","conversation_id","client_id"]
    },{
      foreignKeyName: "outreach_reply_commands_sender_id_client_id_channel_fkey"
      columns: ["sender_id","client_id","channel"]
isOneToOne: false
      referencedRelation: "outreach_reply_senders"
      referencedColumns: ["id","client_id","channel"]
    }
                  ]
                },"outreach_reply_senders": {
                  Row: {
                    "channel": string,"client_id": string,"enabled": boolean,"id": string,"remote_sender_id": string,"sender_address": string,"sender_label": string,"sync_cursor": string | null,"sync_started_at": string | null,"synced_at": string | null,"version": number,"workspace_id": string
                  }
                  Insert: {
                    "channel": string,"client_id": string,"enabled"?: boolean,"id"?: string,"remote_sender_id": string,"sender_address": string,"sender_label": string,"sync_cursor"?: string | null,"sync_started_at"?: string | null,"synced_at"?: string | null,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "channel"?: string,"client_id"?: string,"enabled"?: boolean,"id"?: string,"remote_sender_id"?: string,"sender_address"?: string,"sender_label"?: string,"sync_cursor"?: string | null,"sync_started_at"?: string | null,"synced_at"?: string | null,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_reply_senders_workspace_id_client_id_channel_fkey"
      columns: ["workspace_id","client_id","channel"]
isOneToOne: false
      referencedRelation: "outreach_reply_workspaces"
      referencedColumns: ["id","client_id","channel"]
    }
                  ]
                },"outreach_reply_workspaces": {
                  Row: {
                    "channel": string,"client_id": string,"credential_ref": string,"enabled": boolean,"id": string,"remote_workspace_id": string,"sync_enabled": boolean,"version": number
                  }
                  Insert: {
                    "channel": string,"client_id": string,"credential_ref": string,"enabled"?: boolean,"id"?: string,"remote_workspace_id": string,"sync_enabled"?: boolean,"version"?: number
                  }
                  Update: {
                    "channel"?: string,"client_id"?: string,"credential_ref"?: string,"enabled"?: boolean,"id"?: string,"remote_workspace_id"?: string,"sync_enabled"?: boolean,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_reply_workspaces_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                },"outreach_setup_requests": {
                  Row: {
                    "channel": string,"client_id": string,"created_at": string,"id": string,"method": string,"note": string,"requested_by": string,"status": string,"updated_at": string
                  }
                  Insert: {
                    "channel": string,"client_id": string,"created_at"?: string,"id"?: string,"method": string,"note"?: string,"requested_by": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "channel"?: string,"client_id"?: string,"created_at"?: string,"id"?: string,"method"?: string,"note"?: string,"requested_by"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_setup_requests_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                },"outreach_sync_state": {
                  Row: {
                    "attempt_count": number,"campaign_id": string,"client_id": string,"daily_synced_at": string | null,"last_email_kind": string,"last_error": string | null,"last_served_at": string | null,"lead_cursor": string | null,"leads_synced_at": string | null,"meta_synced_at": string | null,"replies_synced_at": string | null,"reply_cursor": string | null,"reply_scan_started_at": string | null,"reply_watermark": string | null,"retry_after": string | null
                  }
                  Insert: {
                    "attempt_count"?: number,"campaign_id": string,"client_id": string,"daily_synced_at"?: string | null,"last_email_kind"?: string,"last_error"?: string | null,"last_served_at"?: string | null,"lead_cursor"?: string | null,"leads_synced_at"?: string | null,"meta_synced_at"?: string | null,"replies_synced_at"?: string | null,"reply_cursor"?: string | null,"reply_scan_started_at"?: string | null,"reply_watermark"?: string | null,"retry_after"?: string | null
                  }
                  Update: {
                    "attempt_count"?: number,"campaign_id"?: string,"client_id"?: string,"daily_synced_at"?: string | null,"last_email_kind"?: string,"last_error"?: string | null,"last_served_at"?: string | null,"lead_cursor"?: string | null,"leads_synced_at"?: string | null,"meta_synced_at"?: string | null,"replies_synced_at"?: string | null,"reply_cursor"?: string | null,"reply_scan_started_at"?: string | null,"reply_watermark"?: string | null,"retry_after"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_sync_state_campaign_id_client_id_fkey"
      columns: ["campaign_id","client_id"]
isOneToOne: false
      referencedRelation: "outreach_campaigns"
      referencedColumns: ["id","client_id"]
    }
                  ]
                },"outreach_worker_state": {
                  Row: {
                    "email_request_times": (string)[],"lease_expires_at": string | null,"lease_token": string | null,"singleton": boolean
                  }
                  Insert: {
                    "email_request_times"?: (string)[],"lease_expires_at"?: string | null,"lease_token"?: string | null,"singleton"?: boolean
                  }
                  Update: {
                    "email_request_times"?: (string)[],"lease_expires_at"?: string | null,"lease_token"?: string | null,"singleton"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"profiles": {
                  Row: {
                    "full_name": string,"id": string
                  }
                  Insert: {
                    "full_name"?: string,"id": string
                  }
                  Update: {
                    "full_name"?: string,"id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"worker_heartbeats": {
                  Row: {
                    "last_ok_at": string | null,"last_result": string | null,"last_run_at": string,"name": string
                  }
                  Insert: {
                    "last_ok_at"?: string | null,"last_result"?: string | null,"last_run_at"?: string,"name": string
                  }
                  Update: {
                    "last_ok_at"?: string | null,"last_result"?: string | null,"last_run_at"?: string,"name"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "client_outreach_accounts": {
                  Row: {
                    "channel": string | null,"check_error": boolean | null,"client_id": string | null,"display_name": string | null,"email": string | null,"id": string | null,"last_attempt_at": string | null,"last_checked_at": string | null,"last_connected_at": string | null,"state": string | null,"updated_at": string | null
                  }
                  Relationships: [
                    
                  ]
                },"client_outreach_campaign_daily": {
                  Row: {
                    "auto_replies": number | null,"campaign_id": string | null,"client_id": string | null,"contacted": number | null,"day": string | null,"new_contacted": number | null,"opportunities": number | null,"sent": number | null,"unique_clicks": number | null,"unique_opened": number | null,"unique_replies": number | null
                  }
                  Relationships: [
                    
                  ]
                },"client_outreach_campaign_steps": {
                  Row: {
                    "body_text": string | null,"campaign_id": string | null,"client_id": string | null,"delay_days": number | null,"stats": Json | null,"step": number | null,"subject": string | null,"variant": number | null
                  }
                  Relationships: [
                    
                  ]
                },"client_outreach_campaigns": {
                  Row: {
                    "client_id": string | null,"completed_at": string | null,"created_at": string | null,"id": string | null,"name": string | null,"schedule": Json | null,"status": string | null,"synced_at": string | null,"totals": Json | null
                  }
                  Relationships: [
                    
                  ]
                },"client_outreach_invitations": {
                  Row: {
                    "client_id": string | null,"created_at": string | null,"email": string | null,"expires_at": string | null,"id": string | null,"role": string | null,"status": string | null
                  }
                  Relationships: [
                    
                  ]
                },"client_outreach_leads": {
                  Row: {
                    "campaign_id": string | null,"client_id": string | null,"company": string | null,"email": string | null,"first_name": string | null,"id": string | null,"interest": string | null,"last_activity_at": string | null,"last_name": string | null,"last_step": number | null,"reply_count": number | null,"status": string | null
                  }
                  Relationships: [
                    
                  ]
                },"client_outreach_linkedin_daily": {
                  Row: {
                    "client_id": string | null,"day": string | null,"meeting_booked": number | null,"replied": number | null,"sent": number | null,"source": string | null
                  }
                  Relationships: [
                    
                  ]
                },"client_outreach_messages": {
                  Row: {
                    "body_text": string | null,"campaign_id": string | null,"client_id": string | null,"client_read_at": string | null,"direction": string | null,"from_email": string | null,"id": string | null,"interest": string | null,"is_auto_reply": boolean | null,"lead_email": string | null,"sent_at": string | null,"subject": string | null,"thread_key": string | null,"to_email": string | null
                  }
                  Relationships: [
                    
                  ]
                },"client_outreach_setup_requests": {
                  Row: {
                    "channel": string | null,"client_id": string | null,"created_at": string | null,"id": string | null,"method": string | null,"note": string | null,"status": string | null,"updated_at": string | null
                  }
                  Relationships: [
                    
                  ]
                },"client_outreach_team": {
                  Row: {
                    "client_id": string | null,"email": string | null,"role": string | null,"state": string | null,"user_id": string | null,"version": number | null
                  }
                  Relationships: [
                    
                  ]
                },"client_outreach_workspaces": {
                  Row: {
                    "client_id": string | null,"client_name": string | null,"role": string | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "accept_outreach_invitation":
{ Args: { "p_token": string }; Returns: string
                           },
"acquire_outreach_sync_lock":
{ Args: { "p_seconds"?: number,"p_token": string }; Returns: boolean
                           },
"begin_outreach_account_check":
{ Args: { "p_account_id": string,"p_client_id": string }; Returns: string
                           },
"change_outreach_conversation_owner":
{ Args: { "p_client_id": string,"p_conversation_id": string,"p_expected_version": number,"p_owner": string }; Returns: Json
                           },
"change_outreach_membership":
{ Args: { "p_client_id": string,"p_expected_version": number,"p_role": string,"p_state": string,"p_user_id": string }; Returns: undefined
                           },
"claim_outreach_lead_alert":
{ Args: { "p_client_id": string,"p_user_id": string }; Returns: Json
                           },
"claim_outreach_reply":
{ Args: { "p_command_id": string }; Returns: Json
                           },
"configure_outreach_account_workspace":
{ Args: { "p_client_id": string,"p_credential_ref": string,"p_enabled": boolean,"p_remote_workspace_id": string }; Returns: undefined
                           },
"configure_outreach_lead_alert":
{ Args: { "p_client_id": string,"p_cooldown_hours"?: number,"p_enabled": boolean,"p_threshold"?: number,"p_user_id": string }; Returns: Json
                           },
"create_outreach_invitation":
{ Args: { "p_client_id": string,"p_email": string,"p_role": string }; Returns: {
              "expires_at": string,"invitation_id": string,"token": string
            }[]
                           },
"dispatch_outreach_lead_alert":
{ Args: { "p_claim_token": string,"p_delivery_id": string }; Returns: Json
                           },
"dispatch_outreach_reply":
{ Args: { "p_claim_token": string,"p_command_id": string }; Returns: boolean
                           },
"enqueue_outreach_fetch":
{ Args: { "p_lead_email": string,"p_provider_campaign_id": string }; Returns: boolean
                           },
"enqueue_outreach_reply":
{ Args: { "p_body": string,"p_client_id": string,"p_command_id": string,"p_conversation_id": string,"p_expected_version": number,"p_latest_message_id": string,"p_takeover"?: boolean }; Returns: Json
                           },
"finish_outreach_account_check":
{ Args: { "p_check_id": string,"p_error_code"?: string,"p_state"?: string }; Returns: boolean
                           },
"finish_outreach_lead_alert":
{ Args: { "p_claim_token": string,"p_delivery_id": string,"p_error_code"?: string,"p_status": string }; Returns: boolean
                           },
"finish_outreach_reply":
{ Args: { "p_claim_token": string,"p_command_id": string,"p_error_code"?: string,"p_remote_message_id"?: string,"p_status": string }; Returns: boolean
                           },
"inspect_outreach_invitation":
{ Args: { "p_token": string }; Returns: {
              "client_id": string,"client_name": string,"expires_at": string,"invitation_id": string,"role": string,"status": string
            }[]
                           },
"list_outreach_conversations":
{ Args: { "p_before_at"?: string,"p_before_id"?: string,"p_channel"?: string,"p_client_id": string,"p_limit"?: number }; Returns: Json
                           },
"list_outreach_leads":
{ Args: { "p_campaign"?: string,"p_client_id": string,"p_company"?: string,"p_email"?: string,"p_linkedin"?: string,"p_page"?: number,"p_q"?: string,"p_role"?: string,"p_sort"?: string,"p_status"?: string }; Returns: Json
                           },
"mark_outreach_conversation_read":
{ Args: { "p_client_id": string,"p_conversation_id": string }; Returns: undefined
                           },
"mark_outreach_messages_read":
{ Args: { "ids": (string)[] }; Returns: number
                           },
"outreach_lead_alert_delivery_health":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"purge_outreach_messages":
{ Args: { "p_campaign_id": string,"p_token": string }; Returns: boolean
                           },
"read_outreach_account_check":
{ Args: { "p_check_id": string }; Returns: {
              "account_id": string,"client_id": string,"credential_ref": string,"email": string,"remote_workspace_id": string
            }[]
                           },
"read_outreach_conversation":
{ Args: { "p_before_at"?: string,"p_before_id"?: string,"p_client_id": string,"p_conversation_id": string,"p_limit"?: number }; Returns: Json
                           },
"read_outreach_reply":
{ Args: { "p_client_id": string,"p_command_id": string,"p_conversation_id": string }; Returns: Json
                           },
"record_worker_heartbeat":
{ Args: { "result_note"?: string,"succeeded": boolean,"worker_name": string }; Returns: undefined
                           },
"register_outreach_account":
{ Args: { "p_client_id": string,"p_display_name": string,"p_email": string }; Returns: string
                           },
"release_outreach_sync_lock":
{ Args: { "p_token": string }; Returns: boolean
                           },
"request_outreach_setup":
{ Args: { "p_channel": string,"p_client_id": string,"p_method": string }; Returns: string
                           },
"reserve_outreach_email_request":
{ Args: { "p_token": string }; Returns: boolean
                           },
"reserve_outreach_lead_alert_policies":
{ Args: { "p_limit"?: number }; Returns: Json
                           },
"revoke_outreach_invitation":
{ Args: { "p_invitation_id": string }; Returns: undefined
                           },
"sync_outreach_linkedin_conversation":
{ Args: { "p_campaign_id": string,"p_contact_address": string,"p_contact_name": string,"p_messages": Json,"p_remote_campaign_id": string,"p_remote_conversation_id": string,"p_sender_id": string,"p_sender_version": number,"p_subject": string,"p_workspace_version": number }; Returns: string
                           },
"update_outreach_setup_request":
{ Args: { "p_note": string,"p_request_id": string,"p_status": string }; Returns: undefined
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const
