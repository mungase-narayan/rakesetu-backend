CREATE TYPE "public"."email_job_status" AS ENUM('queued', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."email_template" AS ENUM('invitation', 'password_reset');--> statement-breakpoint
CREATE TABLE "email_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"template" "email_template" NOT NULL,
	"status" "email_job_status" DEFAULT 'queued' NOT NULL,
	"to_email" varchar(254) NOT NULL,
	"subject" varchar(255),
	"payload" jsonb NOT NULL,
	"has_secret" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"provider_message_id" varchar(255),
	"correlation_id" varchar(64),
	"requested_by" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_jobs" ADD CONSTRAINT "email_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_jobs" ADD CONSTRAINT "email_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_jobs" ADD CONSTRAINT "email_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_jobs_org_id_created_at_idx" ON "email_jobs" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_jobs_status_idx" ON "email_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_jobs_template_status_idx" ON "email_jobs" USING btree ("template","status");--> statement-breakpoint
CREATE INDEX "email_jobs_user_id_idx" ON "email_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_jobs_correlation_id_idx" ON "email_jobs" USING btree ("correlation_id");