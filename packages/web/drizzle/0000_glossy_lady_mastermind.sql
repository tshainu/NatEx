CREATE TABLE `identity_branch` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`phone` text,
	`lat_e6` integer,
	`lng_e6` integer,
	`type` text NOT NULL,
	`parent_hub_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`counter_rate_card_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`parent_hub_id`) REFERENCES `identity_branch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_branch_code_unique` ON `identity_branch` (`code`);--> statement-breakpoint
CREATE INDEX `identity_branch_parent_hub_idx` ON `identity_branch` (`parent_hub_id`);--> statement-breakpoint
CREATE TABLE `identity_mfa_factor` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret_enc` text NOT NULL,
	`confirmed_at` integer,
	`last_step` integer DEFAULT 0 NOT NULL,
	`seeded` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `identity_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `identity_mfa_recovery_code` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `identity_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `identity_mfa_recovery_user_idx` ON `identity_mfa_recovery_code` (`user_id`);--> statement-breakpoint
CREATE TABLE `identity_otp_challenge` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`sms_ref` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `identity_otp_phone_idx` ON `identity_otp_challenge` (`phone`);--> statement-breakpoint
CREATE TABLE `identity_refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`device_id` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`replaced_by_id` text,
	`mfa_level` text DEFAULT 'none' NOT NULL,
	`family_started_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `identity_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `identity_refresh_user_idx` ON `identity_refresh_token` (`user_id`);--> statement-breakpoint
CREATE TABLE `identity_user` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL,
	`role` text NOT NULL,
	`roles` text DEFAULT '' NOT NULL,
	`username` text,
	`password_hash` text,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`device_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`merchant_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `identity_branch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_user_username_unique` ON `identity_user` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_user_phone_unique` ON `identity_user` (`phone`);--> statement-breakpoint
CREATE INDEX `identity_user_branch_idx` ON `identity_user` (`branch_id`);--> statement-breakpoint
CREATE TABLE `merchants_merchant` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL,
	`pickup_rider_id` text,
	`name` text NOT NULL,
	`vat_no` text,
	`address` text NOT NULL,
	`lat_e6` integer,
	`lng_e6` integer,
	`contact_name` text NOT NULL,
	`contact_phone` text NOT NULL,
	`rate_card_id` text,
	`cod_enabled` integer DEFAULT true NOT NULL,
	`pod_policy` text DEFAULT 'signature' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `merchants_merchant_branch_idx` ON `merchants_merchant` (`branch_id`);--> statement-breakpoint
CREATE TABLE `merchants_onboarding_request` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL,
	`name` text NOT NULL,
	`pickup_rider_id` text,
	`vat_no` text,
	`address` text NOT NULL,
	`lat_e6` integer,
	`lng_e6` integer,
	`contact_name` text NOT NULL,
	`contact_phone` text NOT NULL,
	`cod_enabled` integer DEFAULT true NOT NULL,
	`pod_policy` text DEFAULT 'signature' NOT NULL,
	`created_by_id` text NOT NULL,
	`created_by_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`approved_at` integer,
	`approved_by_id` text,
	`approved_by_name` text,
	`approved_merchant_id` text,
	FOREIGN KEY (`approved_merchant_id`) REFERENCES `merchants_merchant`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `merchants_onboarding_branch_status_created_idx` ON `merchants_onboarding_request` (`branch_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `merchants_onboarding_status_created_idx` ON `merchants_onboarding_request` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `merchants_registration_cooldown` (
	`phone` text PRIMARY KEY NOT NULL,
	`cooldown_until` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `merchants_registration_request` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`business_name` text NOT NULL,
	`contact_name` text NOT NULL,
	`phone` text NOT NULL,
	`email` text NOT NULL,
	`district` text NOT NULL,
	`business_type` text NOT NULL,
	`monthly_volume` text NOT NULL,
	`notes` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`merchant_id` text,
	`created_at` integer NOT NULL,
	`converted_at` integer,
	`receipt_sms_state` text DEFAULT 'queued' NOT NULL,
	`confirmation_sms_state` text DEFAULT 'not_queued' NOT NULL,
	`sms_consent` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants_merchant`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_registration_submission_idx` ON `merchants_registration_request` (`submission_id`);--> statement-breakpoint
CREATE INDEX `merchants_registration_status_created_idx` ON `merchants_registration_request` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `merchants_registration_phone_created_idx` ON `merchants_registration_request` (`phone`,`created_at`);--> statement-breakpoint
CREATE TABLE `merchants_rate_band` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`band` text NOT NULL,
	`label` text NOT NULL,
	`extra_per_kg_cents` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `merchants_rate_card_version`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `merchants_rate_band_version_idx` ON `merchants_rate_band` (`version_id`);--> statement-breakpoint
CREATE TABLE `merchants_rate_card` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`placeholder` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_rate_card_code_unique` ON `merchants_rate_card` (`code`);--> statement-breakpoint
CREATE TABLE `merchants_rate_card_version` (
	`id` text PRIMARY KEY NOT NULL,
	`rate_card_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`volumetric_divisor` integer DEFAULT 5000 NOT NULL,
	`rounding_grams` integer DEFAULT 500 NOT NULL,
	`note` text,
	`activated_at` integer,
	`updated_at` integer NOT NULL,
	`updated_by_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rate_card_id`) REFERENCES `merchants_rate_card`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `merchants_rcv_card_idx` ON `merchants_rate_card_version` (`rate_card_id`);--> statement-breakpoint
CREATE TABLE `merchants_rate_slab` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`band` text NOT NULL,
	`max_grams` integer NOT NULL,
	`price_cents` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `merchants_rate_card_version`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `merchants_rate_slab_version_idx` ON `merchants_rate_slab` (`version_id`);--> statement-breakpoint
CREATE TABLE `merchants_rate_surcharge` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`mode` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `merchants_rate_card_version`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `merchants_rate_surcharge_version_idx` ON `merchants_rate_surcharge` (`version_id`);--> statement-breakpoint
CREATE TABLE `parcels_awb_batch` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_code` text NOT NULL,
	`merchant_id` text NOT NULL,
	`merchant_name` text NOT NULL,
	`assignment_status` text,
	`assignee_type` text,
	`assignee_id` text,
	`assignee_name` text,
	`assigned_at` integer,
	`assigned_by_id` text,
	`assigned_by_name` text,
	`awb_start` text NOT NULL,
	`awb_end` text NOT NULL,
	`label_count` integer DEFAULT 1000 NOT NULL,
	`created_by_id` text NOT NULL,
	`created_by_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parcels_awb_batch_batch_code_unique` ON `parcels_awb_batch` (`batch_code`);--> statement-breakpoint
CREATE INDEX `parcels_awb_batch_merchant_idx` ON `parcels_awb_batch` (`merchant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `parcels_awb_batch_assignee_idx` ON `parcels_awb_batch` (`assignment_status`,`assignee_type`,`assignee_id`);--> statement-breakpoint
CREATE INDEX `parcels_awb_batch_range_idx` ON `parcels_awb_batch` (`awb_start`,`awb_end`);--> statement-breakpoint
CREATE TABLE `parcels_awb_batch_label` (
	`awb` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `parcels_awb_batch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `parcels_awb_batch_label_batch_idx` ON `parcels_awb_batch_label` (`batch_id`,`awb`);--> statement-breakpoint
CREATE TABLE `parcels_awb_batch_series` (
	`series_number` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `parcels_awb_batch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parcels_awb_batch_series_batch_id_unique` ON `parcels_awb_batch_series` (`batch_id`);--> statement-breakpoint
CREATE TABLE `parcels_parcel` (
	`id` text PRIMARY KEY NOT NULL,
	`awb` text NOT NULL,
	`merchant_id` text,
	`branch_id` text NOT NULL,
	`origin_branch_id` text,
	`status` text NOT NULL,
	`weight_grams` integer NOT NULL,
	`length_cm` integer,
	`width_cm` integer,
	`height_cm` integer,
	`description` text,
	`declared_value_cents` integer DEFAULT 0,
	`cod_amount_cents` integer DEFAULT 0 NOT NULL,
	`cod_locked_at` integer,
	`origin_address` text NOT NULL,
	`origin_lat_e6` integer,
	`origin_lng_e6` integer,
	`consignee_name` text NOT NULL,
	`consignee_phone` text NOT NULL,
	`dest_address` text NOT NULL,
	`dest_lat_e6` integer,
	`dest_lng_e6` integer,
	`dest_zone_id` text,
	`delivery_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parcels_parcel_awb_unique` ON `parcels_parcel` (`awb`);--> statement-breakpoint
CREATE INDEX `parcels_parcel_status_idx` ON `parcels_parcel` (`status`);--> statement-breakpoint
CREATE INDEX `parcels_parcel_branch_idx` ON `parcels_parcel` (`branch_id`);--> statement-breakpoint
CREATE INDEX `parcels_parcel_origin_branch_idx` ON `parcels_parcel` (`origin_branch_id`);--> statement-breakpoint
CREATE INDEX `parcels_parcel_merchant_idx` ON `parcels_parcel` (`merchant_id`);--> statement-breakpoint
CREATE TABLE `parcels_parcel_event` (
	`id` text PRIMARY KEY NOT NULL,
	`parcel_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_id` text,
	`actor_name` text,
	`actor_role` text,
	`device_id` text,
	`lat_e6` integer,
	`lng_e6` integer,
	`notes` text,
	`client_id` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `parcels_event_parcel_idx` ON `parcels_parcel_event` (`parcel_id`);--> statement-breakpoint
CREATE INDEX `parcels_event_client_idx` ON `parcels_parcel_event` (`client_id`);--> statement-breakpoint
CREATE TABLE `parcels_retired_tracking_number` (
	`tracking_number` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`retired_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collection_manifest` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`merchant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`rider_id` text,
	`assignment_source` text DEFAULT 'manual' NOT NULL,
	`auto_key` text,
	`pickup_date` text NOT NULL,
	`status` text DEFAULT 'assigned' NOT NULL,
	`signature_url` text,
	`handed_over_at` integer,
	`handover_by_name` text,
	`expected_count` integer DEFAULT 0 NOT NULL,
	`scanned_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_manifest_code_unique` ON `collection_manifest` (`code`);--> statement-breakpoint
CREATE INDEX `collection_manifest_rider_idx` ON `collection_manifest` (`rider_id`);--> statement-breakpoint
CREATE INDEX `collection_manifest_branch_idx` ON `collection_manifest` (`branch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `collection_manifest_auto_key_uq` ON `collection_manifest` (`auto_key`) WHERE "collection_manifest"."auto_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `collection_manifest_item` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest_id` text NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`scanned_at` integer,
	`scanned_by` text
);
--> statement-breakpoint
CREATE INDEX `collection_item_manifest_idx` ON `collection_manifest_item` (`manifest_id`);--> statement-breakpoint
CREATE INDEX `collection_item_parcel_idx` ON `collection_manifest_item` (`parcel_id`);--> statement-breakpoint
CREATE TABLE `collection_pickup_request` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`merchant_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`pickup_date` text NOT NULL,
	`window` text NOT NULL,
	`awbs` text NOT NULL,
	`parcel_count` integer NOT NULL,
	`notes` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`manifest_id` text,
	`requested_by` text NOT NULL,
	`cancelled_at` integer,
	`cancel_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_pickup_request_code_unique` ON `collection_pickup_request` (`code`);--> statement-breakpoint
CREATE INDEX `collection_pickup_request_merchant_idx` ON `collection_pickup_request` (`merchant_id`);--> statement-breakpoint
CREATE INDEX `collection_pickup_request_branch_idx` ON `collection_pickup_request` (`branch_id`,`status`);--> statement-breakpoint
CREATE TABLE `routing_geocode_cache` (
	`address_key` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`lat_e6` integer NOT NULL,
	`lng_e6` integer NOT NULL,
	`provider` text DEFAULT 'seed' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `routing_zone` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`branch_id` text NOT NULL,
	`min_lat_e6` integer NOT NULL,
	`min_lng_e6` integer NOT NULL,
	`max_lat_e6` integer NOT NULL,
	`max_lng_e6` integer NOT NULL,
	`ring` text,
	`serviceable` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `routing_zone_branch_idx` ON `routing_zone` (`branch_id`);--> statement-breakpoint
CREATE TABLE `transport_bag` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`seal_number` text,
	`origin_hub_id` text NOT NULL,
	`dest_hub_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`trip_id` text,
	`weight_grams` integer DEFAULT 0 NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`sealed_at` integer,
	`sealed_by_name` text,
	`received_at` integer,
	`received_by_name` text,
	`created_at` integer NOT NULL,
	`created_by_name` text,
	`photo_ref` text,
	`photo_at` integer,
	`photo_by_name` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transport_bag_code_unique` ON `transport_bag` (`code`);--> statement-breakpoint
CREATE INDEX `transport_bag_status_idx` ON `transport_bag` (`status`);--> statement-breakpoint
CREATE INDEX `transport_bag_branch_idx` ON `transport_bag` (`branch_id`);--> statement-breakpoint
CREATE INDEX `transport_bag_trip_idx` ON `transport_bag` (`trip_id`);--> statement-breakpoint
CREATE INDEX `transport_bag_dest_idx` ON `transport_bag` (`dest_hub_id`);--> statement-breakpoint
CREATE TABLE `transport_bag_item` (
	`id` text PRIMARY KEY NOT NULL,
	`bag_id` text NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`scanned_at` integer NOT NULL,
	`scanned_by_id` text,
	`scanned_by_name` text,
	`device_id` text,
	`removed_at` integer,
	`removed_by_name` text
);
--> statement-breakpoint
CREATE INDEX `transport_bag_item_bag_idx` ON `transport_bag_item` (`bag_id`);--> statement-breakpoint
CREATE INDEX `transport_bag_item_parcel_idx` ON `transport_bag_item` (`parcel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transport_bag_item_unique` ON `transport_bag_item` (`bag_id`,`parcel_id`);--> statement-breakpoint
CREATE TABLE `transport_exception` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'medium' NOT NULL,
	`branch_id` text NOT NULL,
	`awb` text,
	`parcel_id` text,
	`bag_id` text,
	`trip_id` text,
	`detail` text NOT NULL,
	`evidence_json` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`resolved_at` integer,
	`resolved_by_name` text,
	`raised_by_id` text,
	`raised_by_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transport_exception_status_idx` ON `transport_exception` (`status`);--> statement-breakpoint
CREATE INDEX `transport_exception_branch_idx` ON `transport_exception` (`branch_id`);--> statement-breakpoint
CREATE INDEX `transport_exception_kind_idx` ON `transport_exception` (`kind`);--> statement-breakpoint
CREATE TABLE `transport_hub_scan` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`awb` text,
	`parcel_id` text,
	`bag_id` text,
	`trip_id` text,
	`branch_id` text NOT NULL,
	`hub_id` text,
	`outcome` text NOT NULL,
	`reason` text,
	`actor_id` text,
	`actor_name` text,
	`actor_role` text,
	`device_id` text,
	`lat_e6` integer,
	`lng_e6` integer,
	`client_id` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transport_hub_scan_branch_idx` ON `transport_hub_scan` (`branch_id`);--> statement-breakpoint
CREATE INDEX `transport_hub_scan_bag_idx` ON `transport_hub_scan` (`bag_id`);--> statement-breakpoint
CREATE INDEX `transport_hub_scan_ts_idx` ON `transport_hub_scan` (`ts`);--> statement-breakpoint
CREATE INDEX `transport_hub_scan_client_idx` ON `transport_hub_scan` (`client_id`);--> statement-breakpoint
CREATE TABLE `transport_trip` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`vehicle_registration` text NOT NULL,
	`driver_id` text,
	`driver_name` text,
	`origin_hub_id` text NOT NULL,
	`dest_hub_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`route` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`seal` text,
	`departed_at` integer,
	`arrived_at` integer,
	`created_at` integer NOT NULL,
	`created_by_name` text,
	`vehicle_type` text,
	`bus_operator` text,
	`contact_name` text,
	`contact_phone` text,
	`expected_arrival_at` integer,
	`arrival_station` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transport_trip_code_unique` ON `transport_trip` (`code`);--> statement-breakpoint
CREATE INDEX `transport_trip_status_idx` ON `transport_trip` (`status`);--> statement-breakpoint
CREATE INDEX `transport_trip_branch_idx` ON `transport_trip` (`branch_id`);--> statement-breakpoint
CREATE TABLE `delivery_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`runsheet_id` text,
	`runsheet_item_id` text,
	`attempt_no` integer NOT NULL,
	`outcome` text NOT NULL,
	`reason_code` text,
	`reason_label` text,
	`notes` text,
	`pod_id` text,
	`rider_id` text,
	`rider_name` text,
	`device_id` text,
	`lat_e6` integer,
	`lng_e6` integer,
	`client_id` text,
	`client_ts` integer,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_attempt_parcel_idx` ON `delivery_attempt` (`parcel_id`);--> statement-breakpoint
CREATE INDEX `delivery_attempt_runsheet_idx` ON `delivery_attempt` (`runsheet_id`);--> statement-breakpoint
CREATE INDEX `delivery_attempt_client_idx` ON `delivery_attempt` (`client_id`);--> statement-breakpoint
CREATE INDEX `delivery_attempt_reason_idx` ON `delivery_attempt` (`reason_code`);--> statement-breakpoint
CREATE TABLE `delivery_otp` (
	`id` text PRIMARY KEY NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`code_hash` text NOT NULL,
	`sent_to_phone` text NOT NULL,
	`sms_log_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`resend_count` integer DEFAULT 0 NOT NULL,
	`requested_by_id` text,
	`expires_at` integer NOT NULL,
	`verified_at` integer,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_otp_parcel_idx` ON `delivery_otp` (`parcel_id`);--> statement-breakpoint
CREATE TABLE `delivery_pod` (
	`id` text PRIMARY KEY NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`method` text NOT NULL,
	`received_by_name` text NOT NULL,
	`receiver_phone` text,
	`receiver_nic_last4` text,
	`received_by_relation` text,
	`otp_verified` integer DEFAULT false NOT NULL,
	`otp_challenge_id` text,
	`signature_data` text,
	`photo_url` text,
	`photo_note` text,
	`captured_by_id` text,
	`captured_by_name` text,
	`device_id` text,
	`lat_e6` integer,
	`lng_e6` integer,
	`client_id` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_pod_parcel_idx` ON `delivery_pod` (`parcel_id`);--> statement-breakpoint
CREATE INDEX `delivery_pod_client_idx` ON `delivery_pod` (`client_id`);--> statement-breakpoint
CREATE TABLE `delivery_retry_case` (
	`id` text PRIMARY KEY NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`first_attempt_id` text NOT NULL,
	`latest_attempt_id` text NOT NULL,
	`active_rider_id` text,
	`runsheet_id` text,
	`runsheet_item_id` text,
	`last_reason_code` text NOT NULL,
	`last_reason_label` text NOT NULL,
	`reason_allows_reattempt` integer NOT NULL,
	`reason_triggers_rto` integer NOT NULL,
	`reason_notify_consignee` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`first_failure_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`escalating_at` integer,
	`escalated_at` integer,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_retry_case_state_expiry_idx` ON `delivery_retry_case` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `delivery_retry_case_rider_idx` ON `delivery_retry_case` (`active_rider_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_retry_case_parcel_unique` ON `delivery_retry_case` (`parcel_id`);--> statement-breakpoint
CREATE TABLE `delivery_ndr` (
	`id` text PRIMARY KEY NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`branch_id` text NOT NULL,
	`merchant_id` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	`last_reason_code` text,
	`last_reason_label` text,
	`state` text DEFAULT 'open' NOT NULL,
	`merchant_instruction` text,
	`instruction_notes` text,
	`instructed_by_name` text,
	`instructed_at` integer,
	`new_address` text,
	`new_phone` text,
	`reattempt_date` text,
	`reschedule_sms_key` text,
	`reschedule_sms_state` text,
	`sla_due_at` integer,
	`raised_at` integer NOT NULL,
	`actioned_at` integer,
	`actioned_by_name` text,
	`closed_at` integer,
	`close_reason` text
);
--> statement-breakpoint
CREATE INDEX `delivery_ndr_state_idx` ON `delivery_ndr` (`state`);--> statement-breakpoint
CREATE INDEX `delivery_ndr_branch_idx` ON `delivery_ndr` (`branch_id`);--> statement-breakpoint
CREATE INDEX `delivery_ndr_merchant_idx` ON `delivery_ndr` (`merchant_id`);--> statement-breakpoint
CREATE INDEX `delivery_ndr_parcel_idx` ON `delivery_ndr` (`parcel_id`);--> statement-breakpoint
CREATE INDEX `delivery_ndr_sla_idx` ON `delivery_ndr` (`sla_due_at`);--> statement-breakpoint
CREATE TABLE `delivery_reason_code` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`category` text NOT NULL,
	`counts_as_attempt` integer DEFAULT true NOT NULL,
	`allows_reattempt` integer DEFAULT true NOT NULL,
	`triggers_rto` integer DEFAULT false NOT NULL,
	`notify_consignee` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 100 NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_reason_category_idx` ON `delivery_reason_code` (`category`,`sort_order`);--> statement-breakpoint
CREATE TABLE `delivery_rider_daily_performance` (
	`id` text PRIMARY KEY NOT NULL,
	`rider_id` text NOT NULL,
	`rider_name` text NOT NULL,
	`branch_id` text NOT NULL,
	`hub_id` text NOT NULL,
	`performance_date` text NOT NULL,
	`assigned_count` integer DEFAULT 0 NOT NULL,
	`delivered_by_cutoff` integer DEFAULT 0 NOT NULL,
	`target_count` integer DEFAULT 40 NOT NULL,
	`star_count` integer DEFAULT 0 NOT NULL,
	`rate_cents` integer DEFAULT 4000 NOT NULL,
	`payable_cents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'unpaid' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`paid_by` text,
	`paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_rider_daily_performance_date_idx` ON `delivery_rider_daily_performance` (`performance_date`);--> statement-breakpoint
CREATE INDEX `delivery_rider_daily_performance_branch_idx` ON `delivery_rider_daily_performance` (`branch_id`,`performance_date`);--> statement-breakpoint
CREATE INDEX `delivery_rider_daily_performance_status_idx` ON `delivery_rider_daily_performance` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_rider_daily_performance_uq` ON `delivery_rider_daily_performance` (`rider_id`,`performance_date`);--> statement-breakpoint
CREATE TABLE `delivery_rto` (
	`id` text PRIMARY KEY NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`branch_id` text NOT NULL,
	`merchant_id` text,
	`trigger` text NOT NULL,
	`reason` text NOT NULL,
	`state` text DEFAULT 'initiated' NOT NULL,
	`attempts_at_initiation` integer DEFAULT 0 NOT NULL,
	`initiated_at` integer NOT NULL,
	`initiated_by_name` text,
	`dispatched_at` integer,
	`delivered_at` integer,
	`received_by_name` text,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `delivery_rto_state_idx` ON `delivery_rto` (`state`);--> statement-breakpoint
CREATE INDEX `delivery_rto_merchant_idx` ON `delivery_rto` (`merchant_id`);--> statement-breakpoint
CREATE INDEX `delivery_rto_parcel_idx` ON `delivery_rto` (`parcel_id`);--> statement-breakpoint
CREATE TABLE `delivery_runsheet` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`rider_id` text NOT NULL,
	`rider_name` text NOT NULL,
	`branch_id` text NOT NULL,
	`hub_id` text NOT NULL,
	`run_date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`planned_count` integer DEFAULT 0 NOT NULL,
	`delivered_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`cod_expected_cents` integer DEFAULT 0 NOT NULL,
	`cod_collected_cents` integer DEFAULT 0 NOT NULL,
	`freight_expected_cents` integer DEFAULT 0 NOT NULL,
	`freight_collected_cents` integer DEFAULT 0 NOT NULL,
	`route_method` text,
	`route_distance_metres` integer,
	`optimised_at` integer,
	`dispatched_at` integer,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`created_by_name` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_runsheet_code_unique` ON `delivery_runsheet` (`code`);--> statement-breakpoint
CREATE INDEX `delivery_runsheet_rider_idx` ON `delivery_runsheet` (`rider_id`,`run_date`);--> statement-breakpoint
CREATE INDEX `delivery_runsheet_branch_idx` ON `delivery_runsheet` (`branch_id`,`run_date`);--> statement-breakpoint
CREATE INDEX `delivery_runsheet_status_idx` ON `delivery_runsheet` (`status`);--> statement-breakpoint
CREATE TABLE `delivery_runsheet_item` (
	`id` text PRIMARY KEY NOT NULL,
	`runsheet_id` text NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempt_no` integer DEFAULT 0 NOT NULL,
	`consignee_name` text NOT NULL,
	`consignee_phone` text NOT NULL,
	`dest_address` text NOT NULL,
	`dest_lat_e6` integer,
	`dest_lng_e6` integer,
	`leg_metres` integer,
	`cod_amount_cents` integer DEFAULT 0 NOT NULL,
	`freight_amount_cents` integer DEFAULT 0 NOT NULL,
	`freight_payer` text,
	`settled_at` integer,
	`client_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_rs_item_runsheet_idx` ON `delivery_runsheet_item` (`runsheet_id`,`seq`);--> statement-breakpoint
CREATE INDEX `delivery_rs_item_parcel_idx` ON `delivery_runsheet_item` (`parcel_id`);--> statement-breakpoint
CREATE INDEX `delivery_rs_item_state_idx` ON `delivery_runsheet_item` (`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_rs_item_unique` ON `delivery_runsheet_item` (`runsheet_id`,`parcel_id`);--> statement-breakpoint
CREATE TABLE `freight_charge` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`branch_id` text NOT NULL,
	`branch_name` text NOT NULL,
	`payer` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`pricing_basis` text DEFAULT 'manual' NOT NULL,
	`pricing_snapshot_json` text,
	`sender_name` text NOT NULL,
	`sender_phone` text NOT NULL,
	`sender_address` text,
	`recipient_name` text NOT NULL,
	`recipient_phone` text NOT NULL,
	`destination_address` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_by_name` text NOT NULL,
	`booking_request_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`parcel_id`) REFERENCES `parcels_parcel`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`branch_id`) REFERENCES `identity_branch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `freight_charge_code_unique` ON `freight_charge` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `freight_charge_parcel_id_unique` ON `freight_charge` (`parcel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `freight_charge_booking_request_id_unique` ON `freight_charge` (`booking_request_id`);--> statement-breakpoint
CREATE INDEX `freight_charge_branch_idx` ON `freight_charge` (`branch_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `freight_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`charge_id` text NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`branch_id` text NOT NULL,
	`payer` text NOT NULL,
	`entry_type` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`payment_method` text NOT NULL,
	`external_reference` text,
	`code` text NOT NULL,
	`collector_id` text NOT NULL,
	`collector_name` text NOT NULL,
	`collector_role` text NOT NULL,
	`rider_id` text,
	`runsheet_id` text,
	`client_id` text,
	`reversal_of_id` text,
	`reason` text,
	`ts` integer NOT NULL,
	FOREIGN KEY (`charge_id`) REFERENCES `freight_charge`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parcel_id`) REFERENCES `parcels_parcel`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`branch_id`) REFERENCES `identity_branch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `freight_entry_code_unique` ON `freight_entry` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `freight_entry_client_id_unique` ON `freight_entry` (`client_id`);--> statement-breakpoint
CREATE INDEX `freight_entry_branch_idx` ON `freight_entry` (`branch_id`,`ts`);--> statement-breakpoint
CREATE INDEX `freight_entry_charge_idx` ON `freight_entry` (`charge_id`,`ts`);--> statement-breakpoint
CREATE INDEX `freight_entry_rider_idx` ON `freight_entry` (`rider_id`,`ts`);--> statement-breakpoint
CREATE INDEX `freight_entry_awb_idx` ON `freight_entry` (`awb`);--> statement-breakpoint
CREATE UNIQUE INDEX `freight_entry_one_collection_per_charge` ON `freight_entry` (`charge_id`) WHERE "freight_entry"."entry_type" = 'collection';--> statement-breakpoint
CREATE TABLE `freight_reconciliation` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`reference` text NOT NULL,
	`note` text,
	`reconciled_by_id` text NOT NULL,
	`reconciled_by_name` text NOT NULL,
	`reconciled_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `freight_entry`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`branch_id`) REFERENCES `identity_branch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `freight_reconciliation_entry_id_unique` ON `freight_reconciliation` (`entry_id`);--> statement-breakpoint
CREATE INDEX `freight_recon_branch_idx` ON `freight_reconciliation` (`branch_id`,`reconciled_at`);--> statement-breakpoint
CREATE TABLE `notify_message` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`template_key` text NOT NULL,
	`template_version` integer DEFAULT 1 NOT NULL,
	`channel` text NOT NULL,
	`ladder_step` integer DEFAULT 1 NOT NULL,
	`parcel_id` text,
	`awb` text,
	`merchant_id` text,
	`audience` text DEFAULT 'consignee' NOT NULL,
	`to_phone` text,
	`to_user_id` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`reason` text,
	`body` text NOT NULL,
	`sms_log_id` text,
	`provider_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notify_message_group_idx` ON `notify_message` (`group_id`);--> statement-breakpoint
CREATE INDEX `notify_message_parcel_idx` ON `notify_message` (`parcel_id`);--> statement-breakpoint
CREATE INDEX `notify_message_state_idx` ON `notify_message` (`state`);--> statement-breakpoint
CREATE INDEX `notify_message_template_idx` ON `notify_message` (`template_key`);--> statement-breakpoint
CREATE INDEX `notify_message_created_idx` ON `notify_message` (`created_at`);--> statement-breakpoint
CREATE TABLE `notify_template` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`channel_order` text DEFAULT 'whatsapp,sms,push' NOT NULL,
	`audience` text DEFAULT 'consignee' NOT NULL,
	`body_whatsapp` text,
	`body_sms` text,
	`push_title` text,
	`body_push` text,
	`active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_name` text
);
--> statement-breakpoint
CREATE INDEX `notify_template_audience_idx` ON `notify_template` (`audience`);--> statement-breakpoint
CREATE TABLE `sync_conflict` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`client_op_id` text NOT NULL,
	`policy` text NOT NULL,
	`kind` text NOT NULL,
	`device_id` text,
	`user_id` text,
	`user_name` text,
	`branch_id` text,
	`parcel_id` text,
	`awb` text,
	`detail` text NOT NULL,
	`client_claim_json` text,
	`server_state_json` text,
	`state` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`resolution_notes` text,
	`resolved_by_name` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_conflict_state_idx` ON `sync_conflict` (`state`);--> statement-breakpoint
CREATE INDEX `sync_conflict_policy_idx` ON `sync_conflict` (`policy`);--> statement-breakpoint
CREATE INDEX `sync_conflict_parcel_idx` ON `sync_conflict` (`parcel_id`);--> statement-breakpoint
CREATE TABLE `sync_device_cursor` (
	`device_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`last_pull_at` integer,
	`last_push_at` integer,
	`pending_reported` integer DEFAULT 0 NOT NULL,
	`app_version` text,
	`ops_pushed` integer DEFAULT 0 NOT NULL,
	`ops_rejected` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_cursor_user_idx` ON `sync_device_cursor` (`user_id`);--> statement-breakpoint
CREATE TABLE `sync_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`client_op_id` text NOT NULL,
	`device_id` text NOT NULL,
	`user_id` text NOT NULL,
	`user_role` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`client_ts` integer,
	`clock_skew_seconds` integer,
	`state` text DEFAULT 'applied' NOT NULL,
	`result_json` text,
	`error` text,
	`received_at` integer NOT NULL,
	`applied_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_operation_client_op_id_unique` ON `sync_operation` (`client_op_id`);--> statement-breakpoint
CREATE INDEX `sync_operation_device_idx` ON `sync_operation` (`device_id`,`seq`);--> statement-breakpoint
CREATE INDEX `sync_operation_state_idx` ON `sync_operation` (`state`);--> statement-breakpoint
CREATE INDEX `sync_operation_kind_idx` ON `sync_operation` (`kind`);--> statement-breakpoint
CREATE INDEX `sync_operation_received_idx` ON `sync_operation` (`received_at`);--> statement-breakpoint
CREATE TABLE `cod_credit_note` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`invoice_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`reason` text NOT NULL,
	`dispute_id` text,
	`issued_by_id` text NOT NULL,
	`issued_by_name` text NOT NULL,
	`issued_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cod_credit_note_code_unique` ON `cod_credit_note` (`code`);--> statement-breakpoint
CREATE INDEX `cod_credit_note_invoice_idx` ON `cod_credit_note` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `cod_credit_note_merchant_idx` ON `cod_credit_note` (`merchant_id`);--> statement-breakpoint
CREATE TABLE `cod_deposit` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`rider_id` text NOT NULL,
	`rider_name` text NOT NULL,
	`branch_id` text NOT NULL,
	`deposit_date` text NOT NULL,
	`expected_cents` integer DEFAULT 0 NOT NULL,
	`declared_cents` integer NOT NULL,
	`counted_cents` integer,
	`variance_cents` integer,
	`declared_variance_cents` integer,
	`status` text DEFAULT 'declared' NOT NULL,
	`variance_reason` text,
	`bank_ref` text,
	`bank_account` text,
	`banked_at` integer,
	`verified_by_id` text,
	`verified_by_name` text,
	`verified_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`created_by_name` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cod_deposit_code_unique` ON `cod_deposit` (`code`);--> statement-breakpoint
CREATE INDEX `cod_deposit_rider_idx` ON `cod_deposit` (`rider_id`);--> statement-breakpoint
CREATE INDEX `cod_deposit_branch_idx` ON `cod_deposit` (`branch_id`);--> statement-breakpoint
CREATE INDEX `cod_deposit_status_idx` ON `cod_deposit` (`status`);--> statement-breakpoint
CREATE INDEX `cod_deposit_date_idx` ON `cod_deposit` (`deposit_date`);--> statement-breakpoint
CREATE TABLE `cod_deposit_item` (
	`id` text PRIMARY KEY NOT NULL,
	`deposit_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`parcel_id` text NOT NULL,
	`awb` text NOT NULL,
	`amount_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cod_deposit_item_deposit_idx` ON `cod_deposit_item` (`deposit_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cod_deposit_item_entry` ON `cod_deposit_item` (`entry_id`);--> statement-breakpoint
CREATE TABLE `cod_dispute` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`merchant_id` text NOT NULL,
	`merchant_name` text NOT NULL,
	`parcel_id` text,
	`awb` text,
	`type` text NOT NULL,
	`claim_amount_cents` integer DEFAULT 0 NOT NULL,
	`approved_amount_cents` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`description` text NOT NULL,
	`resolution` text,
	`credit_note_id` text,
	`declared_value_cents` integer,
	`cod_amount_cents` integer,
	`remedy` text,
	`invoice_id` text,
	`payout_ref` text,
	`hold_id` text,
	`updated_at` integer,
	`sla_due_at` integer,
	`opened_by_id` text NOT NULL,
	`opened_by_name` text NOT NULL,
	`opened_by_role` text NOT NULL,
	`assigned_to_id` text,
	`assigned_to_name` text,
	`resolved_by_id` text,
	`resolved_by_name` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cod_dispute_code_unique` ON `cod_dispute` (`code`);--> statement-breakpoint
CREATE INDEX `cod_dispute_merchant_idx` ON `cod_dispute` (`merchant_id`);--> statement-breakpoint
CREATE INDEX `cod_dispute_status_idx` ON `cod_dispute` (`status`);--> statement-breakpoint
CREATE INDEX `cod_dispute_parcel_idx` ON `cod_dispute` (`parcel_id`);--> statement-breakpoint
CREATE TABLE `cod_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`debit_account` text NOT NULL,
	`credit_account` text NOT NULL,
	`mode` text DEFAULT 'cash' NOT NULL,
	`ref` text,
	`parcel_id` text,
	`awb` text,
	`merchant_id` text,
	`rider_id` text,
	`branch_id` text,
	`deposit_id` text,
	`settlement_id` text,
	`reversal_of_id` text,
	`reversed_by_id` text,
	`note` text,
	`actor_id` text,
	`actor_name` text,
	`actor_role` text,
	`client_id` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cod_entry_type_idx` ON `cod_entry` (`type`);--> statement-breakpoint
CREATE INDEX `cod_entry_parcel_idx` ON `cod_entry` (`parcel_id`);--> statement-breakpoint
CREATE INDEX `cod_entry_rider_idx` ON `cod_entry` (`rider_id`);--> statement-breakpoint
CREATE INDEX `cod_entry_merchant_idx` ON `cod_entry` (`merchant_id`);--> statement-breakpoint
CREATE INDEX `cod_entry_branch_idx` ON `cod_entry` (`branch_id`);--> statement-breakpoint
CREATE INDEX `cod_entry_deposit_idx` ON `cod_entry` (`deposit_id`);--> statement-breakpoint
CREATE INDEX `cod_entry_settlement_idx` ON `cod_entry` (`settlement_id`);--> statement-breakpoint
CREATE INDEX `cod_entry_debit_idx` ON `cod_entry` (`debit_account`);--> statement-breakpoint
CREATE INDEX `cod_entry_credit_idx` ON `cod_entry` (`credit_account`);--> statement-breakpoint
CREATE INDEX `cod_entry_seq_idx` ON `cod_entry` (`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `cod_entry_one_collect_per_parcel` ON `cod_entry` (`type`,`parcel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cod_entry_client_id` ON `cod_entry` (`client_id`);--> statement-breakpoint
CREATE TABLE `cod_finance_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	`unit` text NOT NULL,
	`description` text NOT NULL,
	`note` text,
	`updated_at` integer NOT NULL,
	`updated_by_name` text
);
--> statement-breakpoint
CREATE TABLE `cod_hold` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`merchant_id` text,
	`parcel_id` text,
	`awb` text,
	`entry_id` text,
	`deposit_id` text,
	`dispute_id` text,
	`amount_cents` integer,
	`detail` text NOT NULL,
	`source_key` text NOT NULL,
	`opened_at` integer NOT NULL,
	`opened_by_id` text,
	`opened_by_name` text,
	`cleared_at` integer,
	`cleared_by_id` text,
	`cleared_by_name` text,
	`cleared_note` text
);
--> statement-breakpoint
CREATE INDEX `cod_hold_merchant_idx` ON `cod_hold` (`merchant_id`);--> statement-breakpoint
CREATE INDEX `cod_hold_parcel_idx` ON `cod_hold` (`parcel_id`);--> statement-breakpoint
CREATE INDEX `cod_hold_status_idx` ON `cod_hold` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `cod_hold_source_key` ON `cod_hold` (`source_key`);--> statement-breakpoint
CREATE TABLE `cod_invariant_run` (
	`id` text PRIMARY KEY NOT NULL,
	`run_date` text NOT NULL,
	`result` text NOT NULL,
	`riders_checked` integer DEFAULT 0 NOT NULL,
	`breach_count` integer DEFAULT 0 NOT NULL,
	`rider_liability_cents` integer DEFAULT 0 NOT NULL,
	`ledger_sum_cents` integer DEFAULT 0 NOT NULL,
	`details_json` text,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`ran_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cod_invariant_run_date_idx` ON `cod_invariant_run` (`run_date`);--> statement-breakpoint
CREATE TABLE `cod_invoice` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`merchant_id` text NOT NULL,
	`merchant_name` text NOT NULL,
	`merchant_vat_no` text,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`due_date` text NOT NULL,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`sscl_cents` integer DEFAULT 0 NOT NULL,
	`vat_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`paid_cents` integer DEFAULT 0 NOT NULL,
	`credited_cents` integer DEFAULT 0 NOT NULL,
	`recovered_cents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`issued_at` integer,
	`void_reason` text,
	`created_at` integer NOT NULL,
	`created_by_name` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cod_invoice_code_unique` ON `cod_invoice` (`code`);--> statement-breakpoint
CREATE INDEX `cod_invoice_merchant_idx` ON `cod_invoice` (`merchant_id`);--> statement-breakpoint
CREATE INDEX `cod_invoice_status_idx` ON `cod_invoice` (`status`);--> statement-breakpoint
CREATE INDEX `cod_invoice_due_idx` ON `cod_invoice` (`due_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `cod_invoice_live_per_period` ON `cod_invoice` (`merchant_id`,`period_start`,`period_end`) WHERE status <> 'void';--> statement-breakpoint
CREATE TABLE `cod_invoice_line` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`description` text NOT NULL,
	`parcel_id` text,
	`awb` text,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_cents` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`taxable` integer DEFAULT true NOT NULL,
	`source_id` text,
	`recovered` integer DEFAULT false NOT NULL,
	`voided` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cod_invoice_line_invoice_idx` ON `cod_invoice_line` (`invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cod_invoice_line_source_key` ON `cod_invoice_line` (`source_id`) WHERE source_id is not null and voided = 0;--> statement-breakpoint
CREATE TABLE `cod_merchant_payout` (
	`merchant_id` text PRIMARY KEY NOT NULL,
	`beneficiary_name` text NOT NULL,
	`bank_name` text NOT NULL,
	`branch_name` text NOT NULL,
	`account_number` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`note` text,
	`updated_at` integer NOT NULL,
	`updated_by_name` text
);
--> statement-breakpoint
CREATE TABLE `cod_ops_alert` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'medium' NOT NULL,
	`audience` text DEFAULT 'ops' NOT NULL,
	`action_required` integer DEFAULT true NOT NULL,
	`rider_id` text,
	`merchant_id` text,
	`parcel_id` text,
	`awb` text,
	`entry_id` text,
	`deposit_id` text,
	`settlement_id` text,
	`dispute_id` text,
	`invariant_run_id` text,
	`amount_cents` integer,
	`summary` text NOT NULL,
	`payload_json` text,
	`source_key` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`acknowledged_at` integer,
	`acknowledged_by_id` text,
	`acknowledged_by_name` text,
	`resolved_at` integer,
	`resolved_by_id` text,
	`resolved_by_name` text,
	`resolution_note` text
);
--> statement-breakpoint
CREATE INDEX `cod_ops_alert_status_idx` ON `cod_ops_alert` (`status`);--> statement-breakpoint
CREATE INDEX `cod_ops_alert_kind_idx` ON `cod_ops_alert` (`kind`);--> statement-breakpoint
CREATE INDEX `cod_ops_alert_rider_idx` ON `cod_ops_alert` (`rider_id`);--> statement-breakpoint
CREATE INDEX `cod_ops_alert_merchant_idx` ON `cod_ops_alert` (`merchant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cod_ops_alert_source_key` ON `cod_ops_alert` (`source_key`);--> statement-breakpoint
CREATE TABLE `cod_settlement` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`merchant_id` text NOT NULL,
	`merchant_name` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`payout_date` text NOT NULL,
	`gross_cents` integer DEFAULT 0 NOT NULL,
	`deductions_cents` integer DEFAULT 0 NOT NULL,
	`net_cents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`hold_reason` text,
	`created_by_id` text NOT NULL,
	`created_by_name` text NOT NULL,
	`proposed_at` integer,
	`approved_by_id` text,
	`approved_by_name` text,
	`approved_at` integer,
	`rejected_reason` text,
	`utr` text,
	`paid_at` integer,
	`exported_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cod_settlement_code_unique` ON `cod_settlement` (`code`);--> statement-breakpoint
CREATE INDEX `cod_settlement_merchant_idx` ON `cod_settlement` (`merchant_id`);--> statement-breakpoint
CREATE INDEX `cod_settlement_status_idx` ON `cod_settlement` (`status`);--> statement-breakpoint
CREATE INDEX `cod_settlement_period_idx` ON `cod_settlement` (`period_start`,`period_end`);--> statement-breakpoint
CREATE UNIQUE INDEX `cod_settlement_open_per_period` ON `cod_settlement` (`merchant_id`,`period_start`,`period_end`) WHERE status in ('draft', 'proposed', 'approved', 'on_hold');--> statement-breakpoint
CREATE TABLE `cod_settlement_line` (
	`id` text PRIMARY KEY NOT NULL,
	`settlement_id` text NOT NULL,
	`type` text NOT NULL,
	`parcel_id` text,
	`awb` text,
	`amount_cents` integer NOT NULL,
	`description` text NOT NULL,
	`entry_id` text
);
--> statement-breakpoint
CREATE INDEX `cod_settlement_line_settlement_idx` ON `cod_settlement_line` (`settlement_id`);--> statement-breakpoint
CREATE INDEX `cod_settlement_line_type_idx` ON `cod_settlement_line` (`type`);--> statement-breakpoint
CREATE INDEX `cod_settlement_line_parcel_idx` ON `cod_settlement_line` (`parcel_id`);--> statement-breakpoint
CREATE TABLE `settings_receipt_contact` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`website` text,
	`company_phone` text,
	`updated_at` integer,
	`updated_by_name` text
);
--> statement-breakpoint
CREATE TABLE `settings_value` (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	`note` text,
	`updated_at` integer NOT NULL,
	`updated_by_name` text
);
--> statement-breakpoint
CREATE TABLE `hr_apit_schedule` (
	`id` text PRIMARY KEY NOT NULL,
	`tax_year` text NOT NULL,
	`version` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text NOT NULL,
	`schedule_json` text NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	`accountant_name` text,
	`validation_reference` text,
	`validated_by` text,
	`validated_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_apit_tax_year_version_uq` ON `hr_apit_schedule` (`tax_year`,`version`);--> statement-breakpoint
CREATE INDEX `hr_apit_schedule_status_idx` ON `hr_apit_schedule` (`status`);--> statement-breakpoint
CREATE TABLE `hr_employee` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_code` text NOT NULL,
	`full_name` text NOT NULL,
	`identity_user_id` text,
	`national_id` text,
	`phone` text,
	`email` text,
	`address` text,
	`permanent_address` text,
	`current_address` text,
	`branch_id` text NOT NULL,
	`department` text NOT NULL,
	`job_title` text NOT NULL,
	`employment_type` text NOT NULL,
	`joined_on` text NOT NULL,
	`ended_on` text,
	`status` text DEFAULT 'active' NOT NULL,
	`epf_number` text,
	`tin` text,
	`primary_employment` integer DEFAULT true NOT NULL,
	`overtime_policy` text DEFAULT 'none' NOT NULL,
	`overtime_multiplier_bps` integer DEFAULT 15000 NOT NULL,
	`overtime_divisor_minutes` integer DEFAULT 14400 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`identity_user_id`) REFERENCES `identity_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_employee_employee_code_unique` ON `hr_employee` (`employee_code`);--> statement-breakpoint
CREATE INDEX `hr_employee_branch_idx` ON `hr_employee` (`branch_id`);--> statement-breakpoint
CREATE INDEX `hr_employee_status_idx` ON `hr_employee` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `hr_employee_identity_user_uq` ON `hr_employee` (`identity_user_id`);--> statement-breakpoint
CREATE TABLE `hr_employee_document` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`category` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_ref` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employee`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_employee_document_storage_ref_unique` ON `hr_employee_document` (`storage_ref`);--> statement-breakpoint
CREATE INDEX `hr_employee_document_employee_idx` ON `hr_employee_document` (`employee_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `hr_employee_package` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`package_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employee`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`package_id`) REFERENCES `hr_salary_package`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hr_employee_package_employee_idx` ON `hr_employee_package` (`employee_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `hr_holiday` (
	`id` text PRIMARY KEY NOT NULL,
	`holiday_date` text NOT NULL,
	`name` text NOT NULL,
	`scope` text DEFAULT 'company' NOT NULL,
	`scope_id` text,
	`ot_allowed` integer DEFAULT false NOT NULL,
	`compulsory_leave` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hr_holiday_date_idx` ON `hr_holiday` (`holiday_date`);--> statement-breakpoint
CREATE INDEX `hr_holiday_scope_idx` ON `hr_holiday` (`scope`,`scope_id`,`holiday_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `hr_holiday_date_scope_uq` ON `hr_holiday` (`holiday_date`,`scope`,`scope_id`);--> statement-breakpoint
CREATE TABLE `hr_leave_adjustment` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`leave_year` integer NOT NULL,
	`half_days_delta` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employee`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leave_type_id`) REFERENCES `hr_leave_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hr_leave_adjust_employee_year_idx` ON `hr_leave_adjustment` (`employee_id`,`leave_year`);--> statement-breakpoint
CREATE TABLE `hr_leave_payout_line` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`employee_code` text NOT NULL,
	`employee_name` text NOT NULL,
	`branch_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`leave_type_name` text NOT NULL,
	`available_half_days` integer NOT NULL,
	`basic_salary_cents` integer NOT NULL,
	`payout_cents` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `hr_leave_payout_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employee`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leave_type_id`) REFERENCES `hr_leave_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hr_leave_payout_line_run_idx` ON `hr_leave_payout_line` (`run_id`);--> statement-breakpoint
CREATE INDEX `hr_leave_payout_line_branch_idx` ON `hr_leave_payout_line` (`branch_id`);--> statement-breakpoint
CREATE TABLE `hr_leave_payout_run` (
	`id` text PRIMARY KEY NOT NULL,
	`year` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`generated_by` text NOT NULL,
	`generated_at` integer NOT NULL,
	`submitted_by` text,
	`submitted_at` integer,
	`approved_by` text,
	`approved_at` integer,
	`payment_reference` text,
	`paid_by` text,
	`paid_at` integer,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`employee_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_leave_payout_run_year_unique` ON `hr_leave_payout_run` (`year`);--> statement-breakpoint
CREATE INDEX `hr_leave_payout_status_idx` ON `hr_leave_payout_run` (`status`);--> statement-breakpoint
CREATE TABLE `hr_leave_request` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`half_days` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_by` text NOT NULL,
	`decided_by` text,
	`decision_note` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employee`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leave_type_id`) REFERENCES `hr_leave_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hr_leave_employee_date_idx` ON `hr_leave_request` (`employee_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `hr_leave_status_idx` ON `hr_leave_request` (`status`);--> statement-breakpoint
CREATE TABLE `hr_leave_type` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`paid` integer NOT NULL,
	`annual_entitlement_half_days` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_leave_type_code_unique` ON `hr_leave_type` (`code`);--> statement-breakpoint
CREATE INDEX `hr_leave_type_active_idx` ON `hr_leave_type` (`active`);--> statement-breakpoint
CREATE TABLE `hr_payroll_line` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`employee_code` text NOT NULL,
	`employee_name` text NOT NULL,
	`epf_number` text,
	`pay_basis` text NOT NULL,
	`gross_cents` integer NOT NULL,
	`epf_base_cents` integer NOT NULL,
	`etf_base_cents` integer NOT NULL,
	`apit_base_cents` integer NOT NULL,
	`employee_epf_cents` integer NOT NULL,
	`employee_etf_cents` integer DEFAULT 0 NOT NULL,
	`employer_epf_cents` integer NOT NULL,
	`employer_etf_cents` integer NOT NULL,
	`apit_cents` integer NOT NULL,
	`other_deductions_cents` integer NOT NULL,
	`net_cents` integer NOT NULL,
	`breakdown_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `hr_payroll_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employee`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_payroll_line_employee_uq` ON `hr_payroll_line` (`run_id`,`employee_id`);--> statement-breakpoint
CREATE INDEX `hr_payroll_line_run_idx` ON `hr_payroll_line` (`run_id`);--> statement-breakpoint
CREATE TABLE `hr_payroll_run` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`apit_schedule_id` text NOT NULL,
	`created_by` text NOT NULL,
	`submitted_at` integer,
	`approved_by` text,
	`approved_at` integer,
	`payment_reference` text,
	`paid_by` text,
	`paid_at` integer,
	`cancelled_by` text,
	`cancelled_at` integer,
	`cancel_reason` text,
	`employee_count` integer DEFAULT 0 NOT NULL,
	`gross_cents` integer DEFAULT 0 NOT NULL,
	`employee_epf_cents` integer DEFAULT 0 NOT NULL,
	`employee_etf_cents` integer DEFAULT 0 NOT NULL,
	`employer_epf_cents` integer DEFAULT 0 NOT NULL,
	`employer_etf_cents` integer DEFAULT 0 NOT NULL,
	`apit_cents` integer DEFAULT 0 NOT NULL,
	`other_deductions_cents` integer DEFAULT 0 NOT NULL,
	`net_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`apit_schedule_id`) REFERENCES `hr_apit_schedule`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_payroll_run_code_unique` ON `hr_payroll_run` (`code`);--> statement-breakpoint
CREATE INDEX `hr_payroll_period_idx` ON `hr_payroll_run` (`period_start`,`period_end`);--> statement-breakpoint
CREATE INDEX `hr_payroll_status_idx` ON `hr_payroll_run` (`status`);--> statement-breakpoint
CREATE TABLE `hr_salary_package` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`pay_basis` text DEFAULT 'monthly' NOT NULL,
	`base_pay_cents` integer NOT NULL,
	`base_epf_eligible` integer DEFAULT true NOT NULL,
	`base_etf_eligible` integer DEFAULT true NOT NULL,
	`base_apit_taxable` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_salary_package_code_unique` ON `hr_salary_package` (`code`);--> statement-breakpoint
CREATE INDEX `hr_salary_package_active_idx` ON `hr_salary_package` (`active`);--> statement-breakpoint
CREATE TABLE `hr_salary_package_item` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`epf_eligible` integer DEFAULT false NOT NULL,
	`etf_eligible` integer DEFAULT false NOT NULL,
	`apit_taxable` integer DEFAULT false NOT NULL,
	`overtime_eligible` integer DEFAULT false NOT NULL,
	`proration` text DEFAULT 'full_period' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `hr_salary_package`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hr_package_item_package_idx` ON `hr_salary_package_item` (`package_id`);--> statement-breakpoint
CREATE TABLE `hr_termination` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`termination_type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`notice_given_on` text,
	`last_working_on` text NOT NULL,
	`reason` text NOT NULL,
	`notes` text,
	`rehire_decision` text DEFAULT 'not_assessed' NOT NULL,
	`checklist_json` text DEFAULT '{}' NOT NULL,
	`created_by` text NOT NULL,
	`submitted_by` text,
	`decided_by` text,
	`decision_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employee`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hr_termination_employee_idx` ON `hr_termination` (`employee_id`);--> statement-breakpoint
CREATE INDEX `hr_termination_status_idx` ON `hr_termination` (`status`);--> statement-breakpoint
CREATE TABLE `hr_timesheet` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`work_date` text NOT NULL,
	`regular_minutes` integer DEFAULT 0 NOT NULL,
	`overtime_minutes` integer DEFAULT 0 NOT NULL,
	`attendance_status` text DEFAULT 'present' NOT NULL,
	`clock_in_at` integer,
	`clock_out_at` integer,
	`approval_status` text DEFAULT 'approved' NOT NULL,
	`approval_note` text,
	`approved_by` text,
	`approved_at` integer,
	`note` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employee`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_timesheet_employee_date_uq` ON `hr_timesheet` (`employee_id`,`work_date`);--> statement-breakpoint
CREATE INDEX `hr_timesheet_date_idx` ON `hr_timesheet` (`work_date`);--> statement-breakpoint
CREATE TABLE `shared_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text,
	`actor_role` text,
	`branch_id` text,
	`device_id` text,
	`request_id` text,
	`before_json` text,
	`after_json` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shared_audit_entity_idx` ON `shared_audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `shared_idempotency_key` (
	`key` text PRIMARY KEY NOT NULL,
	`route` text NOT NULL,
	`user_id` text,
	`request_hash` text NOT NULL,
	`state` text DEFAULT 'in_progress' NOT NULL,
	`response_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shared_idem_route_idx` ON `shared_idempotency_key` (`route`);--> statement-breakpoint
CREATE TABLE `shared_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`payload_json` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`available_at` integer NOT NULL,
	`processed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shared_outbox_state_idx` ON `shared_outbox` (`state`);--> statement-breakpoint
CREATE TABLE `shared_rate_limit` (
	`bucket` text PRIMARY KEY NOT NULL,
	`tokens` integer NOT NULL,
	`refilled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shared_sms_log` (
	`id` text PRIMARY KEY NOT NULL,
	`to_phone` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`purpose` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`gateway_ref` text,
	`raw_response` text,
	`raw_dlr` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shared_sms_ref_idx` ON `shared_sms_log` (`gateway_ref`);