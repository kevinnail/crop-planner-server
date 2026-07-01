CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crop_instances" (
	"user_id" text NOT NULL,
	"uuid" text NOT NULL,
	"section_uuid" text NOT NULL,
	"name" text NOT NULL,
	"plant_count" integer DEFAULT 1 NOT NULL,
	"start_date" text NOT NULL,
	"record_type" text DEFAULT 'plant' NOT NULL,
	"archived" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "crop_instances_user_id_uuid_pk" PRIMARY KEY("user_id","uuid"),
	CONSTRAINT "crop_instances_plant_count_check" CHECK ("crop_instances"."plant_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "crop_stages" (
	"user_id" text NOT NULL,
	"uuid" text NOT NULL,
	"crop_instance_uuid" text NOT NULL,
	"stage_definition_id" integer NOT NULL,
	"duration_weeks" integer NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "crop_stages_user_id_uuid_pk" PRIMARY KEY("user_id","uuid"),
	CONSTRAINT "crop_stages_duration_weeks_check" CHECK ("crop_stages"."duration_weeks" > 0)
);
--> statement-breakpoint
CREATE TABLE "gardens" (
	"user_id" text NOT NULL,
	"uuid" text NOT NULL,
	"location_uuid" text NOT NULL,
	"name" text NOT NULL,
	"record_type" text DEFAULT 'plant' NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "gardens_user_id_uuid_pk" PRIMARY KEY("user_id","uuid")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"user_id" text NOT NULL,
	"uuid" text NOT NULL,
	"name" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "locations_user_id_uuid_pk" PRIMARY KEY("user_id","uuid")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"user_id" text NOT NULL,
	"uuid" text NOT NULL,
	"entity_type" text NOT NULL,
	"week_date" text,
	"crop_instance_uuid" text,
	"content" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "notes_user_id_uuid_pk" PRIMARY KEY("user_id","uuid")
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"user_id" text NOT NULL,
	"uuid" text NOT NULL,
	"garden_uuid" text NOT NULL,
	"name" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "sections_user_id_uuid_pk" PRIMARY KEY("user_id","uuid")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rc_user_id" text NOT NULL,
	"user_id" text,
	"status" varchar(20) NOT NULL,
	"product_id" varchar(255),
	"expires_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_rc_user_id_unique" UNIQUE("rc_user_id")
);
--> statement-breakpoint
CREATE TABLE "task_completions" (
	"user_id" text NOT NULL,
	"uuid" text NOT NULL,
	"task_uuid" text NOT NULL,
	"completed_date" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "task_completions_user_id_uuid_pk" PRIMARY KEY("user_id","uuid")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"user_id" text NOT NULL,
	"uuid" text NOT NULL,
	"crop_instance_uuid" text NOT NULL,
	"task_type_id" integer NOT NULL,
	"day_of_week" integer NOT NULL,
	"frequency_weeks" integer DEFAULT 1 NOT NULL,
	"start_offset_weeks" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "tasks_user_id_uuid_pk" PRIMARY KEY("user_id","uuid"),
	CONSTRAINT "tasks_day_of_week_check" CHECK ("tasks"."day_of_week" BETWEEN 0 AND 6),
	CONSTRAINT "tasks_frequency_weeks_check" CHECK ("tasks"."frequency_weeks" > 0),
	CONSTRAINT "tasks_start_offset_weeks_check" CHECK ("tasks"."start_offset_weeks" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crop_instances" ADD CONSTRAINT "crop_instances_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crop_instances" ADD CONSTRAINT "crop_instances_section_fk" FOREIGN KEY ("user_id","section_uuid") REFERENCES "public"."sections"("user_id","uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crop_stages" ADD CONSTRAINT "crop_stages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crop_stages" ADD CONSTRAINT "crop_stages_crop_instance_fk" FOREIGN KEY ("user_id","crop_instance_uuid") REFERENCES "public"."crop_instances"("user_id","uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gardens" ADD CONSTRAINT "gardens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gardens" ADD CONSTRAINT "gardens_location_fk" FOREIGN KEY ("user_id","location_uuid") REFERENCES "public"."locations"("user_id","uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_crop_instance_fk" FOREIGN KEY ("user_id","crop_instance_uuid") REFERENCES "public"."crop_instances"("user_id","uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_garden_fk" FOREIGN KEY ("user_id","garden_uuid") REFERENCES "public"."gardens"("user_id","uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_task_fk" FOREIGN KEY ("user_id","task_uuid") REFERENCES "public"."tasks"("user_id","uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_crop_instance_fk" FOREIGN KEY ("user_id","crop_instance_uuid") REFERENCES "public"."crop_instances"("user_id","uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_week_cell_unique" ON "notes" USING btree ("user_id","entity_type","crop_instance_uuid","week_date") WHERE entity_type = 'week_cell' AND crop_instance_uuid IS NOT NULL AND week_date IS NOT NULL;--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_completions_task_date_unique" ON "task_completions" USING btree ("user_id","task_uuid","completed_date");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");