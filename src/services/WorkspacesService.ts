// Cloud disabled — local-only stub
import type { Workspace, WorkspaceMember } from "../types/electron";

const _disabled = (): never => {
  throw new Error("cloud disabled");
};

export const WorkspacesService = {
  list: async (): Promise<Workspace[]> => _disabled(),
  create: async (_name: string): Promise<Workspace> => _disabled(),
  get: async (_workspaceId: string): Promise<Workspace> => _disabled(),
  update: async (_workspaceId: string, _patch: unknown): Promise<Workspace> => _disabled(),
  remove: async (_workspaceId: string): Promise<void> => _disabled(),
  listMembers: async (_workspaceId: string): Promise<WorkspaceMember[]> => _disabled(),
  updateMemberRole: async (_workspaceId: string, _userId: string, _role: string): Promise<void> => _disabled(),
  removeMember: async (_workspaceId: string, _userId: string): Promise<void> => _disabled(),
  billingCheckout: async (_workspaceId: string, _interval?: string): Promise<string> => _disabled(),
  billingPortal: async (_workspaceId: string): Promise<string> => _disabled(),
  previewSeats: async (_workspaceId: string, _additionalSeats: number): Promise<never> => _disabled(),
};
