CREATE TABLE "crop_instances" (
	"user_id" text NOT NULL,
	"id" integer NOT NULL,
	"section_id" integer NOT NULL,
	"name" text NOT NULL,
	"plant_count" integer DEFAULT 1 NOT NULL,
	"start_date" text NOT NULL,
	"record_type" text DEFAULT 'plant' NOT NULL,
	"archived" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "crop_instances_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "crop_instances_plant_count_check" CHECK ("crop_instances"."plant_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "crop_stages" (
	"user_id" text NOT NULL,
	"id" integer NOT NULL,
	"crop_instance_id" integer NOT NULL,
	"stage_definition_id" integer NOT NULL,
	"duration_weeks" integer NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "crop_stages_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "crop_stages_duration_weeks_check" CHECK ("crop_stages"."duration_weeks" > 0)
);
--> statement-breakpoint
CREATE TABLE "gardens" (
	"user_id" text NOT NULL,
	"id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"name" text NOT NULL,
	"record_type" text DEFAULT 'plant' NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "gardens_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"user_id" text NOT NULL,
	"id" integer NOT NULL,
	"name" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "locations_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"user_id" text NOT NULL,
	"id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer,
	"week_date" text,
	"crop_instance_id" integer,
	"content" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "notes_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"user_id" text NOT NULL,
	"id" integer NOT NULL,
	"garden_id" integer NOT NULL,
	"name" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sections_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "task_completions" (
	"user_id" text NOT NULL,
	"id" integer NOT NULL,
	"task_id" integer NOT NULL,
	"completed_date" text NOT NULL,
	CONSTRAINT "task_completions_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"user_id" text NOT NULL,
	"id" integer NOT NULL,
	"crop_instance_id" integer NOT NULL,
	"task_type_id" integer NOT NULL,
	"day_of_week" integer NOT NULL,
	"frequency_weeks" integer DEFAULT 1 NOT NULL,
	"start_offset_weeks" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "tasks_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "tasks_day_of_week_check" CHECK ("tasks"."day_of_week" BETWEEN 0 AND 6),
	CONSTRAINT "tasks_frequency_weeks_check" CHECK ("tasks"."frequency_weeks" > 0),
	CONSTRAINT "tasks_start_offset_weeks_check" CHECK ("tasks"."start_offset_weeks" >= 0)
);
--> statement-breakpoint
ALTER TABLE "crop_instances" ADD CONSTRAINT "crop_instances_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crop_instances" ADD CONSTRAINT "crop_instances_section_fk" FOREIGN KEY ("user_id","section_id") REFERENCES "public"."sections"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crop_stages" ADD CONSTRAINT "crop_stages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crop_stages" ADD CONSTRAINT "crop_stages_crop_instance_fk" FOREIGN KEY ("user_id","crop_instance_id") REFERENCES "public"."crop_instances"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gardens" ADD CONSTRAINT "gardens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gardens" ADD CONSTRAINT "gardens_location_fk" FOREIGN KEY ("user_id","location_id") REFERENCES "public"."locations"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_crop_instance_fk" FOREIGN KEY ("user_id","crop_instance_id") REFERENCES "public"."crop_instances"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_garden_fk" FOREIGN KEY ("user_id","garden_id") REFERENCES "public"."gardens"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_task_fk" FOREIGN KEY ("user_id","task_id") REFERENCES "public"."tasks"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_crop_instance_fk" FOREIGN KEY ("user_id","crop_instance_id") REFERENCES "public"."crop_instances"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_week_cell_unique" ON "notes" USING btree ("user_id","entity_type","crop_instance_id","week_date") WHERE entity_type = 'week_cell' AND crop_instance_id IS NOT NULL AND week_date IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_completions_task_date_unique" ON "task_completions" USING btree ("user_id","task_id","completed_date");