// Cloud disabled — local-only stub
const _disabled = (): never => {
  throw new Error("cloud disabled");
};

async function create(_folder: unknown): Promise<never> { return _disabled(); }
async function batchCreate(_folders: unknown): Promise<never> { return _disabled(); }
async function update(_id: string, _updates: unknown): Promise<never> { return _disabled(); }
async function deleteFolder(_id: string): Promise<never> { return _disabled(); }
async function list(_since?: string): Promise<never> { return _disabled(); }

export { create, batchCreate, update, deleteFolder, list };

export const FoldersService = {
  create,
  batchCreate,
  update,
  delete: deleteFolder,
  list,
};
