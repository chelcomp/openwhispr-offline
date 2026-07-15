// Cloud disabled — local-only stub
export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface CreateApiKeyResponse extends ApiKey {
  key: string;
}

export interface CreateApiKeyOptions {
  name: string;
  scopes: string[];
  expiresInDays?: number | null;
}

const _disabled = (): never => {
  throw new Error("cloud disabled");
};

async function listApiKeys(): Promise<never> { return _disabled(); }
async function createApiKey(_options: CreateApiKeyOptions): Promise<never> { return _disabled(); }
async function revokeApiKey(_id: string): Promise<never> { return _disabled(); }

export { listApiKeys, createApiKey, revokeApiKey };

export const ApiKeysService = {
  list: listApiKeys,
  create: createApiKey,
  revoke: revokeApiKey,
};
