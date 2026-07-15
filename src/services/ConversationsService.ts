// Cloud disabled — local-only stub
const _disabled = (): never => {
  throw new Error("cloud disabled");
};

async function create(_input: unknown): Promise<never> { return _disabled(); }
async function update(_id: string, _updates: unknown): Promise<never> { return _disabled(); }
async function deleteConversation(_id: string): Promise<never> { return _disabled(); }
async function list(_limit?: number, _before?: string, _archived?: boolean, _include?: string, _since?: string): Promise<never> { return _disabled(); }
async function addMessage(_conversationId: string, _role: string, _content: string, _metadata?: unknown): Promise<never> { return _disabled(); }
async function listMessages(_conversationId: string): Promise<never> { return _disabled(); }
async function search(_query: string, _limit?: number): Promise<never> { return _disabled(); }

export { create, update, deleteConversation, list, addMessage, listMessages, search };

export const ConversationsService = {
  create,
  update,
  delete: deleteConversation,
  list,
  addMessage,
  listMessages,
  search,
};
