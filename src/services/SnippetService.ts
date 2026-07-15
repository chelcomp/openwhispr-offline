// Cloud disabled — local-only stub
export interface CloudSnippetEntry {
  id: string;
  client_snippet_id: string | null;
  trigger: string;
  replacement: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const _disabled = (): never => {
  throw new Error("cloud disabled");
};

export const SnippetService = {
  batchCreate: async (_entries: unknown): Promise<never> => _disabled(),
  update: async (_id: string, _updates: unknown): Promise<never> => _disabled(),
  delete: async (_id: string): Promise<never> => _disabled(),
  listSnapshot: async (_cursor?: string, _limit?: number, _cursorId?: string): Promise<never> => _disabled(),
  listDelta: async (_since?: string, _limit?: number, _sinceId?: string): Promise<never> => _disabled(),
};
