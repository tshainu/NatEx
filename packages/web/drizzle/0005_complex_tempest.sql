CREATE TABLE `hr_attendance_session` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`work_date` text NOT NULL,
	`clock_in_at` integer NOT NULL,
	`clock_out_at` integer,
	`regular_minutes` integer DEFAULT 0 NOT NULL,
	`overtime_minutes` integer DEFAULT 0 NOT NULL,
	`approval_status` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employee`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hr_attendance_session_employee_date_idx` ON `hr_attendance_session` (`employee_id`,`work_date`);--> statement-breakpoint
CREATE INDEX `hr_attendance_session_open_idx` ON `hr_attendance_session` (`employee_id`,`clock_out_at`);