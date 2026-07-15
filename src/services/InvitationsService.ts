// Cloud disabled — local-only stub
import type { WorkspaceInvitation, InvitationPreview } from "../types/electron";

const _disabled = (): never => {
  throw new Error("cloud disabled");
};

export const InvitationsService = {
  list: async (_workspaceId: string): Promise<WorkspaceInvitation[]> => _disabled(),
  send: async (_workspaceId: string, _input: unknown): Promise<WorkspaceInvitation> => _disabled(),
  revoke: async (_workspaceId: string, _invitationId: string): Promise<void> => _disabled(),
  resend: async (_workspaceId: string, _invitationId: string): Promise<void> => _disabled(),
  preview: async (_token: string): Promise<InvitationPreview> => _disabled(),
  accept: async (_token: string): Promise<{ workspace_id: string; role: string }> => _disabled(),
};
