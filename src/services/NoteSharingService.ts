// Cloud disabled — local-only stub
import type { NoteShareInvitation, ShareSettings, ShareVisibility } from "../types/electron";

export interface ShareStateResponse {
  share: ShareSettings;
  invitations: NoteShareInvitation[];
}

export interface ShareMutationResponse {
  share: ShareSettings;
  raw_token: string | null;
}

export interface RotateTokenResponse {
  share: ShareSettings;
  raw_token: string;
}

export interface CreateInvitationsResponse {
  created: NoteShareInvitation[];
  already_invited: string[];
  email_failed_ids: string[];
}

const _disabled = (): never => {
  throw new Error("cloud disabled");
};

export const NoteSharingService = {
  getShareSettings: async (_cloudNoteId: string): Promise<ShareStateResponse> => _disabled(),
  updateShareSettings: async (_cloudNoteId: string, _visibility: ShareVisibility, _domainAllowlist: string[]): Promise<ShareMutationResponse> => _disabled(),
  clearShare: async (_cloudNoteId: string): Promise<{ share: ShareSettings }> => _disabled(),
  rotateToken: async (_cloudNoteId: string): Promise<RotateTokenResponse> => _disabled(),
  inviteEmails: async (_cloudNoteId: string, _emails: string[]): Promise<CreateInvitationsResponse> => _disabled(),
  revokeInvite: async (_cloudNoteId: string, _invitationId: string): Promise<void> => _disabled(),
  resendInvite: async (_cloudNoteId: string, _invitationId: string): Promise<{ id: string; resent: boolean }> => _disabled(),
};
