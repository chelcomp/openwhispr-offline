// Cloud disabled — local-only stub
export type DictionarySource = "manual" | "learned";

export interface CloudDictionaryEntry {
  id: string;
  client_dict_id: string | null;
  word: string;
  source: DictionarySource;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const _disabled = (): never => {
  throw new Error("cloud disabled");
};

export const DictionaryService = {
  batchCreate: async (_entries: unknown): Promise<never> => _disabled(),
  update: async (_id: string, _updates: unknown): Promise<never> => _disabled(),
  delete: async (_id: string): Promise<never> => _disabled(),
  list: async (_since?: string, _limit?: number, _sinceId?: string): Promise<never> => _disabled(),
};
