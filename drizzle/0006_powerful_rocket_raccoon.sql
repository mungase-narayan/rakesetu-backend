-- Phase 4 — the event spine.
--
-- HAND-EDITED after `drizzle-kit generate`. Drizzle cannot declare a
-- partitioned table, so the generated `CREATE TABLE "rake_events"` was
-- replaced with the PARTITION BY form below, twelve monthly partitions and a
-- DEFAULT. The snapshot in drizzle/meta is unaware of the partitioning, which
-- is harmless: partitioning is invisible to every column diff drizzle-kit
-- computes. Re-generating this file would silently drop it — edit, never
-- regenerate.
--
-- `scripts/ensure-partitions.ts` (npm run db:partitions) keeps the next three
-- months created and belongs in a monthly cron.

CREATE TYPE "public"."event_source" AS ENUM('simulator', 'manual', 'fois', 'ai_extraction', 'correction');--> statement-breakpoint
CREATE TYPE "public"."rake_event_type" AS ENUM('ALLOTTED', 'DEPARTED_EMPTY', 'ARRIVED_LOADING_YARD', 'PLACED_FOR_LOADING', 'LOADING_STARTED', 'LOADING_COMPLETE', 'LOADED_RELEASED', 'DEPARTED_ORIGIN', 'SECTION_PASSED', 'ARRIVED_DEST', 'PLACED_FOR_UNLOADING', 'UNLOADING_STARTED', 'UNLOADING_COMPLETE', 'UNLOADED_RELEASED', 'DEPARTED_EMPTY_RETURN', 'EMPTY_AVAILABLE', 'DETAINED', 'DETENTION_CLEARED', 'MARKED_SICK', 'SICK_CLEARED', 'DIVERTED', 'DIVERSION_CLEARED', 'HELD_FOR_ORDER', 'HOLD_RELEASED', 'CORRECTION');--> statement-breakpoint
CREATE TABLE "rake_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rake_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"tat_hours" numeric(8, 2),
	"buckets" jsonb,
	"origin_terminal_id" uuid,
	"dest_terminal_id" uuid,
	"commodity_code" varchar(20),
	"indent_id" uuid,
	"consignment_id" uuid,
	"net_weight_t" numeric(10, 2),
	"is_closed" boolean DEFAULT false NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rake_event_keys" (
	"idempotency_key" varchar(120) PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rake_events" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rake_id" uuid NOT NULL,
	"cycle_id" uuid,
	"event_type" "rake_event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"station_code" varchar(8),
	"terminal_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" "event_source" NOT NULL,
	"source_ref" varchar(120),
	"recorded_by" uuid,
	"idempotency_key" varchar(120) NOT NULL,
	"applied" boolean DEFAULT true NOT NULL,
	"rejection_reason" varchar(200),
	"corrects_event_id" uuid,
	"correlation_id" varchar(64),
	CONSTRAINT "rake_events_id_occurred_at_pk" PRIMARY KEY("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE TABLE "rake_events_2026_01" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_02" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-02-01 00:00:00+00') TO ('2026-03-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_03" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-03-01 00:00:00+00') TO ('2026-04-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_04" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-05-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_05" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_06" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_07" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_08" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_09" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_10" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_11" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "rake_events_2026_12" PARTITION OF "rake_events"
	FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
--> statement-breakpoint
-- The safety net. Without it an event dated outside every declared range
-- fails the INSERT outright, and losing an operational fact because a cron
-- job did not run is a far worse outcome than storing it in the wrong file.
-- `db:partitions` reports anything that lands here.
CREATE TABLE "rake_events_default" PARTITION OF "rake_events" DEFAULT;
--> statement-breakpoint
CREATE TABLE "rake_states" (
	"rake_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"state" "rake_state" NOT NULL,
	"previous_state" "rake_state",
	"station_code" varchar(8),
	"terminal_id" uuid,
	"since" timestamp with time zone NOT NULL,
	"cycle_id" uuid,
	"last_event_id" uuid,
	"last_event_at" timestamp with time zone,
	"indent_id" uuid,
	"is_dirty" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rake_cycles" ADD CONSTRAINT "rake_cycles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_cycles" ADD CONSTRAINT "rake_cycles_rake_id_rakes_id_fk" FOREIGN KEY ("rake_id") REFERENCES "public"."rakes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_cycles" ADD CONSTRAINT "rake_cycles_origin_terminal_id_terminals_id_fk" FOREIGN KEY ("origin_terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_cycles" ADD CONSTRAINT "rake_cycles_dest_terminal_id_terminals_id_fk" FOREIGN KEY ("dest_terminal_id") REFERENCES "public"."terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_cycles" ADD CONSTRAINT "rake_cycles_commodity_code_commodities_code_fk" FOREIGN KEY ("commodity_code") REFERENCES "public"."commodities"("code") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_event_keys" ADD CONSTRAINT "rake_event_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_events" ADD CONSTRAINT "rake_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_events" ADD CONSTRAINT "rake_events_rake_id_rakes_id_fk" FOREIGN KEY ("rake_id") REFERENCES "public"."rakes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_events" ADD CONSTRAINT "rake_events_station_code_stations_code_fk" FOREIGN KEY ("station_code") REFERENCES "public"."stations"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_events" ADD CONSTRAINT "rake_events_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_events" ADD CONSTRAINT "rake_events_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_states" ADD CONSTRAINT "rake_states_rake_id_rakes_id_fk" FOREIGN KEY ("rake_id") REFERENCES "public"."rakes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_states" ADD CONSTRAINT "rake_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_states" ADD CONSTRAINT "rake_states_station_code_stations_code_fk" FOREIGN KEY ("station_code") REFERENCES "public"."stations"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_states" ADD CONSTRAINT "rake_states_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rake_cycles_org_id_started_at_idx" ON "rake_cycles" USING btree ("org_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rake_cycles_rake_id_started_at_idx" ON "rake_cycles" USING btree ("rake_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rake_cycles_is_closed_idx" ON "rake_cycles" USING btree ("is_closed");--> statement-breakpoint
CREATE INDEX "rake_event_keys_event_id_idx" ON "rake_event_keys" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "rake_events_rake_id_occurred_at_idx" ON "rake_events" USING btree ("rake_id","occurred_at");--> statement-breakpoint
CREATE INDEX "rake_events_cycle_id_idx" ON "rake_events" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "rake_events_org_id_occurred_at_idx" ON "rake_events" USING btree ("org_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rake_events_event_type_idx" ON "rake_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "rake_events_applied_idx" ON "rake_events" USING btree ("applied");--> statement-breakpoint
CREATE INDEX "rake_states_org_id_state_idx" ON "rake_states" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "rake_states_station_code_idx" ON "rake_states" USING btree ("station_code");--> statement-breakpoint
CREATE INDEX "rake_states_is_dirty_idx" ON "rake_states" USING btree ("is_dirty");