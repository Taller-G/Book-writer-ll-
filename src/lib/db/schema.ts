// Typed mirror of the DDL in bootstrap.ts — tables are created there (raw
// SQL, including the append-only triggers); this file only describes them to
// Drizzle for typed queries. Keep both in sync.
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author").notNull().default(""),
  currentStage: integer("current_stage").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const stageProgress = sqliteTable(
  "stage_progress",
  {
    projectId: text("project_id").notNull(),
    stage: integer("stage").notNull(),
    status: text("status", {
      enum: ["not_started", "in_progress", "done"],
    })
      .notNull()
      .default("not_started"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.stage] })],
);

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  kind: text("kind", {
    enum: ["transcript", "audio", "document", "notes"],
  }).notNull(),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  // File-backed sources only; all null for pasted sources.
  mediaType: text("media_type", {
    enum: ["audio", "video", "document", "image", "text"],
  }),
  originalName: text("original_name"),
  originalPath: text("original_path"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  checksumSha1: text("checksum_sha1"),
  durationSeconds: real("duration_seconds"),
  language: text("language"),
  wordCount: integer("word_count"),
  linkedSourceId: text("linked_source_id"),
});

export const editorialContracts = sqliteTable("editorial_contracts", {
  projectId: text("project_id").primaryKey(),
  mode: text("mode", { enum: ["verbatim", "prose", "hybrid"] }).notNull(),
  rules: text("rules").notNull().default(""),
  notes: text("notes").notNull().default(""),
  signedAt: text("signed_at"),
});

export const styleProfiles = sqliteTable("style_profiles", {
  projectId: text("project_id").primaryKey(),
  tone: text("tone").notNull().default(""),
  register: text("register").notNull().default(""),
  person: text("person").notNull().default(""),
  notes: text("notes").notNull().default(""),
  data: text("data").notNull().default("{}"),
  updatedAt: text("updated_at").notNull(),
});

export const stageTexts = sqliteTable("stage_texts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  stageKey: text("stage_key", {
    enum: ["raw", "passA", "passB", "final"],
  }).notNull(),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  jobId: text("job_id"),
  createdAt: text("created_at").notNull(),
});

export const changeLog = sqliteTable("change_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull(),
  what: text("what").notNull(),
  where: text("where").notNull(),
  why: text("why").notNull(),
  authorizedBy: text("authorized_by").notNull(),
  createdAt: text("created_at").notNull(),
});

export const reviewQueue = sqliteTable("review_queue", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  itemType: text("item_type").notNull().default("edit"),
  excerpt: text("excerpt").notNull().default(""),
  question: text("question").notNull(),
  status: text("status", { enum: ["pending", "accepted", "rejected"] })
    .notNull()
    .default("pending"),
  resolutionNote: text("resolution_note").notNull().default(""),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const formatConfigs = sqliteTable("format_configs", {
  projectId: text("project_id").primaryKey(),
  trimSize: text("trim_size").notNull().default("6x9in"),
  fontFamily: text("font_family").notNull().default("Garamond"),
  fontSizePt: real("font_size_pt").notNull().default(11),
  lineHeight: real("line_height").notNull().default(1.4),
  margins: text("margins").notNull(),
  data: text("data").notNull().default("{}"),
  updatedAt: text("updated_at").notNull(),
});

export const pdfVersions = sqliteTable("pdf_versions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  version: integer("version").notNull(),
  filePath: text("file_path").notNull(),
  notes: text("notes").notNull().default(""),
  jobId: text("job_id"),
  createdAt: text("created_at").notNull(),
});

export const covers = sqliteTable("covers", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  filePath: text("file_path"),
  selected: integer("selected").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const checklistItems = sqliteTable("checklist_items", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  label: text("label").notNull(),
  done: integer("done").notNull().default(0),
  note: text("note").notNull().default(""),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  stage: integer("stage").notNull(),
  type: text("type").notNull(),
  status: text("status", {
    enum: ["queued", "running", "succeeded", "failed"],
  })
    .notNull()
    .default("queued"),
  attempt: integer("attempt").notNull().default(1),
  retryOf: text("retry_of"),
  inputVersion: integer("input_version").notNull().default(1),
  input: text("input").notNull().default("{}"),
  outputVersion: integer("output_version"),
  output: text("output"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
});

export const aiUsage = sqliteTable("ai_usage", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  jobId: text("job_id"),
  role: text("role", { enum: ["large", "fast"] }).notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const userPrefs = sqliteTable("user_prefs", {
  id: integer("id").primaryKey(),
  preferences: text("preferences").notNull().default("{}"),
  apiKeyCiphertext: text("api_key_ciphertext"),
  apiKeyIv: text("api_key_iv"),
  apiKeyTag: text("api_key_tag"),
  updatedAt: text("updated_at").notNull(),
});

export type Project = typeof projects.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type EditorialContract = typeof editorialContracts.$inferSelect;
export type StyleProfile = typeof styleProfiles.$inferSelect;
export type StageText = typeof stageTexts.$inferSelect;
export type ChangeLogEntry = typeof changeLog.$inferSelect;
export type ReviewItem = typeof reviewQueue.$inferSelect;
export type FormatConfig = typeof formatConfigs.$inferSelect;
export type PdfVersion = typeof pdfVersions.$inferSelect;
export type Cover = typeof covers.$inferSelect;
export type ChecklistItem = typeof checklistItems.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type StageProgressRow = typeof stageProgress.$inferSelect;
