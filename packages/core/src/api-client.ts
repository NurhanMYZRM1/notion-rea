import type {
  AgentGrantInfo,
  ApiError,
  CommentInfo,
  DatabaseInfo,
  Filter,
  HierarchyResult,
  InvitationInfo,
  MemberInfo,
  PageDetail,
  PageSummary,
  PropertyDef,
  PropertyValue,
  RecordRow,
  SearchHit,
  Sort,
  ViewConfig,
  ViewInfo,
  WorkspaceInfo,
} from "./contracts";
import type { Role } from "./permissions";
import type { PMNode } from "./blocks";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiError["error"]["code"] | "network",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ApiClientOptions {
  /** "" for same-origin web; the deployment origin for native. */
  baseUrl: string;
  /** Native apps attach the session cookie here; web relies on the browser. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

export interface Me {
  user: { id: string; email: string; name: string; image: string | null; emailVerified: boolean };
  workspaces: WorkspaceInfo[];
}

/** Typed client for the Workspace REST API (shared by web and native). */
export function createApiClient(opts: ApiClientOptions) {
  const f = opts.fetch ?? fetch;
  async function request<T>(method: string, path: string, body?: unknown, raw?: { body: BodyInit; headers: Record<string, string> }): Promise<T> {
    const headers: Record<string, string> = { ...(await opts.headers?.()), ...raw?.headers };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      const init = { method, headers, body: raw?.body ?? (body === undefined ? undefined : JSON.stringify(body)), credentials: "include" } as RequestInit;
      res = await f(`${opts.baseUrl}${path}`, init);
    } catch (err) {
      throw new ApiRequestError(0, "network", "You appear to be offline", err);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const e = (data as ApiError | undefined)?.error;
      throw new ApiRequestError(res.status, e?.code ?? "internal", e?.message ?? `Request failed (${res.status})`, e?.details);
    }
    return data as T;
  }
  const get = <T>(p: string) => request<T>("GET", p);
  const post = <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {});
  const patch = <T>(p: string, b: unknown) => request<T>("PATCH", p, b);
  const put = <T>(p: string, b: unknown) => request<T>("PUT", p, b);
  const del = <T>(p: string) => request<T>("DELETE", p);
  const q = (params: Record<string, string | null | undefined>) => {
    const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
    return s ? `?${s}` : "";
  };

  return {
    baseUrl: opts.baseUrl,
    providers: () => get<{ google: boolean; apple: boolean; testLogin: boolean }>("/api/providers"),
    me: () => get<Me>("/api/me"),
    deleteAccount: () => del<{ ok: true }>("/api/me"),
    acceptInvitation: (token: string) => post<{ workspaceId: string; role: Role }>("/api/invitations/accept", { token }),
    agentGrants: () => get<{ grants: (AgentGrantInfo & { workspaceName: string })[] }>("/api/agent-grants"),
    revokeAgentGrant: (id: string) => del<{ ok: true }>(`/api/agent-grants/${id}`),

    renameWorkspace: (ws: string, name: string) => patch<{ ok: true }>(`/api/w/${ws}`, { name }),
    children: (ws: string, parentId: string | null, cursor?: string | null) =>
      get<{ pages: PageSummary[]; nextCursor: string | null }>(`/api/w/${ws}/pages${q({ parentId, cursor })}`),
    createPage: (ws: string, input: { parentId?: string | null; title?: string; id?: string; afterId?: string | null }) =>
      post<{ page: PageSummary }>(`/api/w/${ws}/pages`, input),
    favorites: (ws: string) => get<{ pages: PageSummary[] }>(`/api/w/${ws}/favorites`),
    recents: (ws: string) => get<{ pages: PageSummary[] }>(`/api/w/${ws}/recents`),
    trash: (ws: string) => get<{ pages: PageSummary[] }>(`/api/w/${ws}/trash`),
    search: (ws: string, query: string) => get<{ results: SearchHit[] }>(`/api/w/${ws}/search${q({ q: query })}`),
    members: (ws: string) => get<{ members: MemberInfo[] }>(`/api/w/${ws}/members`),
    updateMember: (ws: string, userId: string, role: Role) => patch<{ ok: true }>(`/api/w/${ws}/members/${userId}`, { role }),
    removeMember: (ws: string, userId: string) => del<{ ok: true }>(`/api/w/${ws}/members/${userId}`),
    invitations: (ws: string) => get<{ invitations: InvitationInfo[] }>(`/api/w/${ws}/invitations`),
    invite: (ws: string, email: string, role: Role) => post<{ invitation: InvitationInfo; url: string }>(`/api/w/${ws}/invitations`, { email, role }),
    revokeInvitation: (ws: string, id: string) => del<{ ok: true }>(`/api/w/${ws}/invitations/${id}`),
    createDatabase: (ws: string, input: { parentId?: string | null; title?: string; id?: string; schema?: PropertyDef[] }) =>
      post<{ database: DatabaseInfo }>(`/api/w/${ws}/databases`, input),
    importMarkdown: (ws: string, input: { markdown: string; parentId?: string | null; title?: string }) =>
      post<{ page: PageSummary; warnings: string[] }>(`/api/w/${ws}/import/markdown`, input),
    importCsv: (ws: string, input: { csv: string; parentId?: string | null; title: string }) =>
      post<{ database: DatabaseInfo; imported: number; rejected: { row: number; reason: string }[]; warnings: string[] }>(`/api/w/${ws}/import/csv`, input),

    page: (id: string) => get<{ page: PageDetail }>(`/api/pages/${id}`),
    hierarchy: (ws: string, options: { parentId?: string | null; cursor?: string | null; limit?: number; focusId?: string } = {}) =>
      get<HierarchyResult>(`/api/w/${ws}/hierarchy${q({ parentId: options.parentId, cursor: options.cursor, limit: options.limit === undefined ? undefined : String(options.limit), focusId: options.focusId })}`),
    createSubpage: (parentId: string, input: { id: string; title?: string; afterBlockId?: string }) =>
      post<{ page: PageSummary; parentRevision: number }>(`/api/pages/${parentId}/subpages`, input),
    updatePage: (id: string, input: { expectedRevision: number; title?: string; icon?: string | null }) => patch<{ page: PageSummary }>(`/api/pages/${id}`, input),
    movePage: (id: string, input: { expectedRevision: number; parentId: string | null; afterId?: string | null }) =>
      post<{ page: PageSummary }>(`/api/pages/${id}/move`, input),
    archivePage: (id: string, input?: { expectedParentId?: string | null }) => post<{ page: PageSummary }>(`/api/pages/${id}/archive`, input),
    restorePage: (id: string) => post<{ page: PageSummary }>(`/api/pages/${id}/restore`),
    deletePage: (id: string) => del<{ deleted: number }>(`/api/pages/${id}`),
    setFavorite: (id: string, favorite: boolean) => put<{ ok: true }>(`/api/pages/${id}/favorite`, { favorite }),
    visit: (id: string) => post<{ ok: true }>(`/api/pages/${id}/visit`),
    document: (id: string) => get<{ doc: PMNode; revision: number }>(`/api/pages/${id}/document`),
    /** Structured block edits (same ops as the MCP edit_blocks tool). */
    editBlocks: (id: string, ops: unknown[], expectedRevision: number | null = null) =>
      post<{ revision: number; insertedIds: string[]; warnings: string[]; changed: boolean }>(`/api/pages/${id}/edit`, { ops, expectedRevision }),
    exportMarkdown: (id: string) => get<{ markdown: string; warnings: string[]; revision: number }>(`/api/pages/${id}/export.md?format=json`),
    comments: (id: string) => get<{ comments: CommentInfo[] }>(`/api/pages/${id}/comments`),
    addComment: (id: string, body: string, commentId?: string) => post<{ comment: CommentInfo }>(`/api/pages/${id}/comments`, { body, id: commentId }),
    deleteComment: (id: string, commentId: string) => del<{ ok: true }>(`/api/pages/${id}/comments/${commentId}`),
    upload: (pageId: string, file: { name: string; type: string; size: number; body: BodyInit }) =>
      request<{ id: string; src: string; name: string; mimeType: string; size: number }>("POST", `/api/pages/${pageId}/attachments`, undefined, {
        body: file.body,
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "Content-Length": String(file.size) },
      }),

    database: (id: string) => get<{ database: DatabaseInfo }>(`/api/databases/${id}`),
    updateSchema: (id: string, expectedRevision: number, schema: PropertyDef[]) => put<{ database: DatabaseInfo }>(`/api/databases/${id}/schema`, { expectedRevision, schema }),
    createView: (id: string, input: { name: string; type: "table" | "board"; config?: Partial<ViewConfig> }) => post<{ view: ViewInfo }>(`/api/databases/${id}/views`, input),
    updateView: (id: string, viewId: string, input: { expectedRevision: number; name?: string; type?: "table" | "board"; config?: ViewConfig }) =>
      patch<{ view: ViewInfo }>(`/api/databases/${id}/views/${viewId}`, input),
    deleteView: (id: string, viewId: string) => del<{ ok: true }>(`/api/databases/${id}/views/${viewId}`),
    query: (id: string, input: { filters?: Filter[]; sorts?: Sort[]; cursor?: string | null; limit?: number }) =>
      post<{ records: RecordRow[]; nextCursor: string | null; schemaRevision: number }>(`/api/databases/${id}/query`, input),
    createRecord: (id: string, values: Record<string, PropertyValue> = {}, recordId?: string) => post<{ record: RecordRow }>(`/api/databases/${id}/records`, { values, id: recordId }),
    record: (id: string) => get<{ record: RecordRow }>(`/api/records/${id}`),
    updateRecord: (id: string, expectedRevision: number, values: Record<string, PropertyValue>) => patch<{ record: RecordRow }>(`/api/records/${id}`, { expectedRevision, values }),
    exportCsvUrl: (id: string) => `${opts.baseUrl}/api/databases/${id}/export.csv`,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
