// Cloud disabled — local-only stub
const _disabled = (): never => {
  throw new Error("cloud disabled");
};

async function create(_note: unknown): Promise<never> { return _disabled(); }
async function batchCreate(_notes: unknown): Promise<never> { return _disabled(); }
async function update(_id: string, _updates: unknown): Promise<never> { return _disabled(); }
async function deleteNote(_id: string): Promise<never> { return _disabled(); }
async function deleteAll(): Promise<never> { return _disabled(); }
async function list(_limit?: number, _before?: string, _since?: string): Promise<never> { return _disabled(); }
async function search(_query: string, _limit?: number): Promise<never> { return _disabled(); }

export { create, batchCreate, update, deleteNote, deleteAll, list, search };

export const NotesService = {
  create,
  batchCreate,
  update,
  delete: deleteNote,
  deleteAll,
  list,
  search,
};
