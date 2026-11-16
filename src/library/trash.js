// OWNER: organise agent. Moves files into and out of <root>/.slate-trash. See docs/architecture.md "Trash".
// export function createTrash() -> { move(root, path), restore(root, path), purge(root, path) }
export function createTrash() {
  const no = async () => { throw new Error('trash not built yet'); };
  return { move: no, restore: no, purge: no };
}
