CREATE TYPE "public"."charge_rule_type" AS ENUM('free_time', 'demurrage', 'wharfage', 'bsc', 'dev_charge', 'terminal_charge', 'base_rate');--> statement-breakpoint
CREATE TYPE "public"."commodity_group" AS ENUM('cement', 'coal', 'steel', 'foodgrain', 'fertiliser', 'petroleum', 'container', 'other');--> statement-breakpoint
CREATE TYPE "public"."customer_tier" AS ENUM('platinum', 'gold', 'silver', 'standard');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('rate_circular', 'goods_tariff', 'commodity_classification', 'demurrage_rule', 'embargo_notice', 'zonal_instruction', 'forwarding_note', 'rr', 'waiver_evidence', 'other');--> statement-breakpoint
CREATE TYPE "public"."handling_mode" AS ENUM('mechanised', 'manual', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."line_type" AS ENUM('single', 'double', 'multiple');--> statement-breakpoint
CREATE TYPE "public"."rake_state" AS ENUM('EMPTY_AVAILABLE', 'ALLOTTED', 'MOVING_TO_LOADING', 'PLACED_FOR_LOADING', 'LOADING', 'LOADED_RELEASED', 'IN_TRANSIT_LOADED', 'AT_DEST_YARD', 'PLACED_FOR_UNLOADING', 'UNLOADING', 'UNLOADED_RELEASED', 'EMPTY_RETURNING', 'DETAINED', 'SICK', 'DIVERTED', 'HELD_FOR_ORDER');--> statement-breakpoint
CREATE TYPE "public"."terminal_type" AS ENUM('goods_shed', 'private_siding', 'pft', 'port');--> statement-breakpoint
CREATE TYPE "public"."wagon_owner" AS ENUM('IR', 'WIS', 'GPWIS', 'private');--> statement-breakpoint
CREATE TYPE "public"."wagon_status" AS ENUM('available', 'in_use', 'sick', 'poh_due', 'condemned');--> statement-breakpoint
CREATE TABLE "charge_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" charge_rule_type NOT NULL,
	"params" jsonb NOT NULL,
	"selector" jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"circular_ref" varchar(120) NOT NULL,
	"document_id" uuid,
	"clause_ref" varchar(60),
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commodities" (
	"code" varchar(20) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"commodity_group" "commodity_group" NOT NULL,
	"class" varchar(10) NOT NULL,
	"min_weight_condition" varchar(20) NOT NULL,
	"is_hazardous" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_sidings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"commodity_codes" varchar(20)[] NOT NULL,
	"is_default_loading" boolean DEFAULT false NOT NULL,
	"is_default_dest" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_org_id" uuid,
	"code" varchar(20) NOT NULL,
	"name" varchar(200) NOT NULL,
	"gstin" varchar(15),
	"tier" "customer_tier" DEFAULT 'standard' NOT NULL,
	"credit_limit" numeric(14, 2),
	"contact_email" varchar(254),
	"contact_phone" varchar(20),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "document_type" NOT NULL,
	"title" varchar(300) NOT NULL,
	"number" varchar(120),
	"issued_on" date,
	"effective_from" date,
	"superseded_by_id" uuid,
	"superseded_at" date,
	"s3_key" varchar(500) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"page_count" integer,
	"is_corpus" boolean DEFAULT false NOT NULL,
	"uploaded_by" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chargeable_distances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_code" varchar(8) NOT NULL,
	"to_code" varchar(8) NOT NULL,
	"km" integer NOT NULL,
	"source_ref" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_code" varchar(8) NOT NULL,
	"to_code" varchar(8) NOT NULL,
	"distance_km" numeric(7, 2) NOT NULL,
	"line_type" "line_type" NOT NULL,
	"max_axle_load_t" numeric(5, 2) NOT NULL,
	"is_electrified" boolean DEFAULT true NOT NULL,
	"nominal_speed_kmph" numeric(5, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stations" (
	"code" varchar(8) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"division" varchar(60) NOT NULL,
	"zone" varchar(10) NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"lng" numeric(9, 6) NOT NULL,
	"is_junction" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wagon_types" (
	"code" varchar(20) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"tare_t" numeric(6, 2) NOT NULL,
	"cc_t" numeric(6, 2) NOT NULL,
	"cc_plus_8_2_t" numeric(6, 2) NOT NULL,
	"commodity_groups" "commodity_group"[] NOT NULL,
	"length_m" numeric(6, 2) NOT NULL,
	"is_covered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wagons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" varchar(20) NOT NULL,
	"type_code" varchar(20) NOT NULL,
	"owner" "wagon_owner" NOT NULL,
	"owner_org_id" uuid,
	"poh_due_on" date NOT NULL,
	"fitness_due_on" date NOT NULL,
	"status" "wagon_status" DEFAULT 'available' NOT NULL,
	"built_year" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rake_compositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rake_id" uuid NOT NULL,
	"wagon_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"wagon_type_code" varchar(20) NOT NULL,
	"wagon_count" integer NOT NULL,
	"owner" "wagon_owner" NOT NULL,
	"home_division" varchar(60) NOT NULL,
	"current_state" "rake_state" DEFAULT 'EMPTY_AVAILABLE' NOT NULL,
	"current_station" varchar(8),
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embargoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"circular_ref" varchar(120),
	"document_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_code" varchar(8) NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(120) NOT NULL,
	"type" "terminal_type" NOT NULL,
	"placement_lines" integer NOT NULL,
	"is_mechanised" boolean DEFAULT false NOT NULL,
	"handling_mode" "handling_mode" NOT NULL,
	"commodity_groups" "commodity_group"[] NOT NULL,
	"max_rake_length" integer NOT NULL,
	"avg_placement_minutes" integer DEFAULT 90 NOT NULL,
	"operator_org_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "charge_rules" ADD CONSTRAINT "charge_rules_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_rules" ADD CONSTRAINT "charge_rules_supersedes_id_charge_rules_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."charge_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sidings" ADD CONSTRAINT "customer_sidings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sidings" ADD CONSTRAINT "customer_sidings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sidings" ADD CONSTRAINT "customer_sidings_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_customer_org_id_organizations_id_fk" FOREIGN KEY ("customer_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_superseded_by_id_documents_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeable_distances" ADD CONSTRAINT "chargeable_distances_from_code_stations_code_fk" FOREIGN KEY ("from_code") REFERENCES "public"."stations"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeable_distances" ADD CONSTRAINT "chargeable_distances_to_code_stations_code_fk" FOREIGN KEY ("to_code") REFERENCES "public"."stations"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_from_code_stations_code_fk" FOREIGN KEY ("from_code") REFERENCES "public"."stations"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_to_code_stations_code_fk" FOREIGN KEY ("to_code") REFERENCES "public"."stations"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wagons" ADD CONSTRAINT "wagons_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wagons" ADD CONSTRAINT "wagons_type_code_wagon_types_code_fk" FOREIGN KEY ("type_code") REFERENCES "public"."wagon_types"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wagons" ADD CONSTRAINT "wagons_owner_org_id_organizations_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_compositions" ADD CONSTRAINT "rake_compositions_rake_id_rakes_id_fk" FOREIGN KEY ("rake_id") REFERENCES "public"."rakes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rake_compositions" ADD CONSTRAINT "rake_compositions_wagon_id_wagons_id_fk" FOREIGN KEY ("wagon_id") REFERENCES "public"."wagons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rakes" ADD CONSTRAINT "rakes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rakes" ADD CONSTRAINT "rakes_wagon_type_code_wagon_types_code_fk" FOREIGN KEY ("wagon_type_code") REFERENCES "public"."wagon_types"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rakes" ADD CONSTRAINT "rakes_current_station_stations_code_fk" FOREIGN KEY ("current_station") REFERENCES "public"."stations"("code") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embargoes" ADD CONSTRAINT "embargoes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embargoes" ADD CONSTRAINT "embargoes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_station_code_stations_code_fk" FOREIGN KEY ("station_code") REFERENCES "public"."stations"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_operator_org_id_organizations_id_fk" FOREIGN KEY ("operator_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "charge_rules_type_effective_from_idx" ON "charge_rules" USING btree ("type","effective_from");--> statement-breakpoint
CREATE INDEX "charge_rules_selector_gin_idx" ON "charge_rules" USING gin ("selector" jsonb_path_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "customer_sidings_customer_id_terminal_id_key" ON "customer_sidings" USING btree ("customer_id","terminal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_id_code_key" ON "customers" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "customers_customer_org_id_idx" ON "customers" USING btree ("customer_org_id");--> statement-breakpoint
CREATE INDEX "documents_org_id_type_idx" ON "documents" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "documents_number_idx" ON "documents" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_sha256_org_id_key" ON "documents" USING btree ("sha256","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chargeable_distances_from_to_key" ON "chargeable_distances" USING btree ("from_code","to_code");--> statement-breakpoint
CREATE UNIQUE INDEX "sections_from_to_key" ON "sections" USING btree ("from_code","to_code");--> statement-breakpoint
CREATE INDEX "sections_from_code_idx" ON "sections" USING btree ("from_code");--> statement-breakpoint
CREATE INDEX "sections_to_code_idx" ON "sections" USING btree ("to_code");--> statement-breakpoint
CREATE INDEX "stations_division_idx" ON "stations" USING btree ("division");--> statement-breakpoint
CREATE INDEX "stations_zone_idx" ON "stations" USING btree ("zone");--> statement-breakpoint
CREATE UNIQUE INDEX "wagons_number_key" ON "wagons" USING btree ("number");--> statement-breakpoint
CREATE INDEX "wagons_org_id_idx" ON "wagons" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "wagons_type_code_idx" ON "wagons" USING btree ("type_code");--> statement-breakpoint
CREATE INDEX "wagons_poh_due_on_idx" ON "wagons" USING btree ("poh_due_on");--> statement-breakpoint
CREATE INDEX "rake_compositions_rake_id_from_ts_idx" ON "rake_compositions" USING btree ("rake_id","from_ts");--> statement-breakpoint
CREATE INDEX "rake_compositions_wagon_id_idx" ON "rake_compositions" USING btree ("wagon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rake_compositions_current_position_key" ON "rake_compositions" USING btree ("rake_id","position") WHERE "rake_compositions"."to_ts" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "rakes_org_id_code_key" ON "rakes" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "rakes_current_state_idx" ON "rakes" USING btree ("current_state");--> statement-breakpoint
CREATE INDEX "rakes_current_station_idx" ON "rakes" USING btree ("current_station");--> statement-breakpoint
CREATE INDEX "embargoes_org_id_window_idx" ON "embargoes" USING btree ("org_id","from_ts","to_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "terminals_org_id_code_key" ON "terminals" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "terminals_station_code_idx" ON "terminals" USING btree ("station_code");