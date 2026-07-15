// Cloud disabled — local-only stub
const _disabled = (): never => {
  throw new Error("cloud disabled");
};

async function create(_transcription: unknown): Promise<never> { return _disabled(); }
async function batchCreate(_transcriptions: unknown): Promise<never> { return _disabled(); }
async function list(_limit?: number, _before?: string, _since?: string): Promise<never> { return _disabled(); }
async function deleteTranscription(_id: string): Promise<never> { return _disabled(); }
async function batchDelete(_ids: string[]): Promise<never> { return _disabled(); }

export { create, batchCreate, list, deleteTranscription, batchDelete };

export const TranscriptionsService = {
  create,
  batchCreate,
  list,
  delete: deleteTranscription,
  batchDelete,
};
