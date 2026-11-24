CREATE TABLE `rider_gps_day` (
	`id` text PRIMARY KEY NOT NULL,
	`rider_id` text NOT NULL,
	`work_date` text NOT NULL,
	`clock_in_at` integer NOT NULL,
	`clock_out_at` integer,
	`distance_meters` integer DEFAULT 0 NOT NULL,
	`accepted_points` integer DEFAULT 0 NOT NULL,
	`rejected_points` integer DEFAULT 0 NOT NULL,
	`last_point_at` integer,
	`sync_state` text DEFAULT 'live' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rider_gps_day_rider_date_uq` ON `rider_gps_day` (`rider_id`,`work_date`);--> statement-breakpoint
CREATE INDEX `rider_gps_day_date_idx` ON `rider_gps_day` (`work_date`);--> statement-breakpoint
CREATE TABLE `rider_gps_point` (
	`id` text PRIMARY KEY NOT NULL,
	`day_id` text NOT NULL,
	`client_point_id` text NOT NULL,
	`captured_at` integer NOT NULL,
	`latitude_e6` integer NOT NULL,
	`longitude_e6` integer NOT NULL,
	`accuracy_meters` integer NOT NULL,
	`speed_mps` integer DEFAULT 0 NOT NULL,
	`accepted` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`day_id`) REFERENCES `rider_gps_day`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rider_gps_point_client_uq` ON `rider_gps_point` (`day_id`,`client_point_id`);--> statement-breakpoint
CREATE INDEX `rider_gps_point_day_time_idx` ON `rider_gps_point` (`day_id`,`captured_at`);