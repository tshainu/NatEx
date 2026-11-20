ALTER TABLE `hr_payroll_run` ADD COLUMN `cutoff_date` text NOT NULL DEFAULT '1970-01-01';
ALTER TABLE `hr_payroll_line` ADD COLUMN `allowances_cents` integer NOT NULL DEFAULT 0;
ALTER TABLE `hr_payroll_line` ADD COLUMN `paid_leave_half_days` integer NOT NULL DEFAULT 0;
ALTER TABLE `hr_payroll_line` ADD COLUMN `unpaid_leave_half_days` integer NOT NULL DEFAULT 0;
ALTER TABLE `hr_payroll_line` ADD COLUMN `last_month_leave_half_days` integer NOT NULL DEFAULT 0;
ALTER TABLE `hr_payroll_line` ADD COLUMN `approved_by` text;
ALTER TABLE `hr_payroll_line` ADD COLUMN `approved_at` integer;
