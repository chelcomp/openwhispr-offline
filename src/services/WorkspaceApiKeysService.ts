// Cloud disabled — local-only stub
import type { WorkspaceApiKey, NewWorkspaceApiKey } from "../types/electron";

const _disabled = (): never => {
  throw new Error("cloud disabled");
};

export const WorkspaceApiKeysService = {
  list: async (_workspaceId: string): Promise<WorkspaceApiKey[]> => _disabled(),
  create: async (_workspaceId: string, _input: unknown): Promise<NewWorkspaceApiKey> => _disabled(),
  revoke: async (_workspaceId: string, _keyId: string): Promise<void> => _disabled(),
};
