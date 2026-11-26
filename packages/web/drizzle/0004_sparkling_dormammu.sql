ALTER TABLE `parcels_parcel` ADD `cod_includes_delivery_charge` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `parcels_parcel` ADD `delivery_charge_included_cents` integer;