/**
 * Info passed to the post-create rebuild hook when create_table succeeds:
 * the per-table write tool that should become available immediately and the
 * table it belongs to.
 *
 * Lives in shared types (not in tool-assembly.ts): both agents and the
 * tool-assembly module import it, and the agent modules are part of an
 * import cycle with tool-assembly — a type reference through that cycle
 * degrades to `never` during checking.
 */
export interface ICreateTableRebuildInfo {
  toolName: string;
  tableName: string;
}
