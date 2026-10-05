ALTER TABLE "users" ADD COLUMN "kdf_salt" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kdf_version" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "key_wrap" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "key_wrap_version" integer;