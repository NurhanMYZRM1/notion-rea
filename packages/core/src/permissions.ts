export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type Capability =
  | "read" // read pages, databases, comments, attachments, search
  | "write" // edit content, create pages/records, comment, upload
  | "archive" // move pages to trash and restore them
  | "manage_members" // invite, remove, change roles
  | "delete_permanently"; // empty trash

const GRANTS: Record<Role, readonly Capability[]> = {
  owner: ["read", "write", "archive", "manage_members", "delete_permanently"],
  editor: ["read", "write", "archive"],
  viewer: ["read"],
};

export function can(role: Role | null | undefined, capability: Capability): boolean {
  return role != null && GRANTS[role].includes(capability);
}

/** OAuth scopes for agent access. Each grant is bound to one workspace. */
export const AGENT_SCOPES = ["workspace:read", "workspace:write", "workspace:archive"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const SCOPE_CAPABILITY: Record<AgentScope, Capability> = {
  "workspace:read": "read",
  "workspace:write": "write",
  "workspace:archive": "archive",
};

/** An agent may do X only if its scope allows X AND the person behind it still may. */
export function agentCan(role: Role | null | undefined, scopes: readonly string[], capability: Capability): boolean {
  const scoped = AGENT_SCOPES.some((s) => scopes.includes(s) && SCOPE_CAPABILITY[s] === capability);
  return scoped && can(role, capability);
}
