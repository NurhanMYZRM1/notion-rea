import { z } from "zod";
import { ROLES } from "./permissions";

export const id = z.string().regex(/^[a-z]{1,4}_[0-9A-Za-z]{8,40}$/, "invalid id");
export const role = z.enum(ROLES);
const title = z.string().max(500);

// ---------- Pages ----------

export const PageState = z.enum(["active", "archived", "deleted"]);
export type PageState = z.infer<typeof PageState>;

export interface PageSummary {
  id: string;
  workspaceId: string;
  parentId: string | null;
  databaseId: string | null;
  isDatabase: boolean;
  title: string;
  icon: string | null;
  position: string;
  state: PageState;
  hasChildren: boolean;
  revision: number;
  updatedAt: number;
  url: string;
}

export interface PageDetail extends PageSummary {
  props: Record<string, PropertyValue>;
  breadcrumbs: { id: string; title: string }[];
  createdAt: number;
  createdBy: string;
  archivedAt: number | null;
  favorite: boolean;
}

export const CreatePageInput = z.object({
  parentId: id.nullable().default(null),
  title: title.default(""),
  icon: z.string().max(16).nullable().optional(),
  /** Insert after this sibling; omitted = append. */
  afterId: id.nullable().optional(),
  /** Client-generated id so retries are idempotent. */
  id: id.optional(),
});

export const UpdatePageInput = z.object({
  expectedRevision: z.number().int().positive(),
  title: title.optional(),
  icon: z.string().max(16).nullable().optional(),
});

export const MovePageInput = z.object({
  expectedRevision: z.number().int().positive(),
  parentId: id.nullable(),
  afterId: id.nullable().optional(),
});

// ---------- Databases ----------

export const PROPERTY_TYPES = ["title", "text", "number", "date", "select", "status", "checkbox", "url"] as const;
export const PropertyType = z.enum(PROPERTY_TYPES);
export type PropertyType = z.infer<typeof PropertyType>;

export const propId = z.string().regex(/^p_[0-9A-Za-z]{4,24}$/);
export const optionId = z.string().regex(/^o_[0-9A-Za-z]{4,24}$/);

export const SelectOption = z.object({
  id: optionId,
  name: z.string().min(1).max(100),
  color: z.enum(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]).default("gray"),
});
export type SelectOption = z.infer<typeof SelectOption>;

export const PropertyDef = z.object({
  id: propId,
  name: z.string().min(1).max(100),
  type: PropertyType,
  options: z.array(SelectOption).max(100).optional(),
});
export type PropertyDef = z.infer<typeof PropertyDef>;

export const DatabaseSchema = z
  .array(PropertyDef)
  .min(1)
  .max(50)
  .refine((props) => props.filter((p) => p.type === "title").length === 1, "exactly one title property")
  .refine((props) => new Set(props.map((p) => p.id)).size === props.length, "duplicate property id");

export type PropertyValue = string | number | boolean | null;

export const FILTER_OPS = {
  title: ["contains", "not_contains", "equals", "is_empty", "is_not_empty"],
  text: ["contains", "not_contains", "equals", "is_empty", "is_not_empty"],
  url: ["contains", "not_contains", "equals", "is_empty", "is_not_empty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"],
  date: ["on", "before", "after", "is_empty", "is_not_empty"],
  select: ["is", "is_not", "is_empty", "is_not_empty"],
  status: ["is", "is_not", "is_empty", "is_not_empty"],
  checkbox: ["is"],
} as const satisfies Record<PropertyType, readonly string[]>;

export const Filter = z.object({
  propId,
  op: z.string().max(20),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).optional(),
});
export type Filter = z.infer<typeof Filter>;

export const Sort = z.object({ propId: z.union([propId, z.literal("created_at")]), direction: z.enum(["asc", "desc"]) });
export type Sort = z.infer<typeof Sort>;

export const ViewConfig = z.object({
  filters: z.array(Filter).max(10).default([]),
  sorts: z.array(Sort).max(3).default([]),
  groupBy: propId.nullable().default(null),
  hiddenProps: z.array(propId).max(50).default([]),
});
export type ViewConfig = z.infer<typeof ViewConfig>;

export const ViewType = z.enum(["table", "board"]);

export const CreateDatabaseInput = z.object({
  parentId: id.nullable().default(null),
  title: title.default("Untitled database"),
  id: id.optional(),
  schema: DatabaseSchema.optional(),
});

export const UpdateSchemaInput = z.object({
  expectedRevision: z.number().int().positive(),
  schema: DatabaseSchema,
});

export const CreateViewInput = z.object({
  name: z.string().min(1).max(100),
  type: ViewType,
  config: ViewConfig.default({ filters: [], sorts: [], groupBy: null, hiddenProps: [] }),
});

export const UpdateViewInput = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().min(1).max(100).optional(),
  type: ViewType.optional(),
  config: ViewConfig.optional(),
});

export const QueryRecordsInput = z.object({
  filters: z.array(Filter).max(10).default([]),
  sorts: z.array(Sort).max(3).default([]),
  cursor: z.string().max(2000).nullable().default(null),
  limit: z.number().int().min(1).max(200).default(50),
});
export type QueryRecordsInput = z.infer<typeof QueryRecordsInput>;

export const RecordValues = z.record(propId, z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]));

export const CreateRecordInput = z.object({
  id: id.optional(),
  values: RecordValues.default({}),
});

export const UpdateRecordInput = z.object({
  expectedRevision: z.number().int().positive(),
  values: RecordValues,
});

export interface DatabaseInfo {
  id: string;
  workspaceId: string;
  title: string;
  schema: PropertyDef[];
  revision: number;
  views: ViewInfo[];
  url: string;
}

export interface ViewInfo {
  id: string;
  name: string;
  type: "table" | "board";
  config: ViewConfig;
  revision: number;
}

export interface RecordRow {
  id: string;
  title: string;
  values: Record<string, PropertyValue>;
  revision: number;
  createdAt: number;
  updatedAt: number;
  url: string;
}

// ---------- Comments, members, invitations ----------

export const CreateCommentInput = z.object({ body: z.string().trim().min(1).max(5000), id: id.optional() });

export interface CommentInfo {
  id: string;
  pageId: string;
  author: { id: string; name: string; image: string | null };
  body: string;
  createdAt: number;
}

export const CreateInvitationInput = z.object({
  email: z.email().max(320).transform((e) => e.toLowerCase()),
  role,
});

export const UpdateMemberInput = z.object({ role });

export interface MemberInfo {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: z.infer<typeof role>;
  joinedAt: number;
}

export interface InvitationInfo {
  id: string;
  email: string;
  role: z.infer<typeof role>;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "accepted" | "expired" | "revoked";
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  role: z.infer<typeof role>;
}

export interface SearchHit {
  pageId: string;
  title: string;
  snippet: string;
  url: string;
}

export interface AgentGrantInfo {
  id: string;
  clientName: string;
  clientId: string;
  workspaceId: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

/** Structured API error body. */
export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_input"
  | "gone"
  | "too_large"
  | "unsupported"
  | "rate_limited"
  | "internal";
