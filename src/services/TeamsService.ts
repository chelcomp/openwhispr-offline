// Cloud disabled — local-only stub
import type { Team, TeamMember } from "../types/electron";

const _disabled = (): never => {
  throw new Error("cloud disabled");
};

export const TeamsService = {
  list: async (_workspaceId: string): Promise<Team[]> => _disabled(),
  create: async (_workspaceId: string, _input: unknown): Promise<Team> => _disabled(),
  update: async (_teamId: string, _patch: unknown): Promise<Team> => _disabled(),
  remove: async (_teamId: string): Promise<void> => _disabled(),
  listMembers: async (_teamId: string): Promise<TeamMember[]> => _disabled(),
  addMember: async (_teamId: string, _userId: string, _role?: string): Promise<void> => _disabled(),
  removeMember: async (_teamId: string, _userId: string): Promise<void> => _disabled(),
};
