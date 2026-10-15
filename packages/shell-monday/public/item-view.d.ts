export interface ColumnValue {
  id: string;
  type: string;
  text: string | null;
  column: { title: string };
}
export declare function pickColumns(columnValues: ColumnValue[]): {
  tax?: ColumnValue;
  country?: ColumnValue;
  domain?: ColumnValue;
  status?: ColumnValue;
};
export interface ItemViewDeps {
  document: Document;
  monday: {
    api: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ data: any }>;
    get: (what: 'sessionToken' | 'context') => Promise<{ data: any }>;
    execute: (type: string, args?: unknown) => Promise<unknown>;
  };
  fetch: typeof fetch;
  apiBase?: string;
}
export declare function createItemView(deps: ItemViewDeps): {
  load: (context: { boardId: number; itemId: number; theme?: string }) => Promise<void>;
  verify: () => Promise<unknown>;
  render: (r: unknown) => void;
};
