export interface ModalDeps {
  document: Document;
  sdk: { execute: (command: string, args?: unknown) => Promise<unknown> };
  Command: Record<string, string>;
  fetch: typeof fetch;
  params: URLSearchParams;
  apiBase?: string;
}
export declare function createModal(deps: ModalDeps): { verify: () => Promise<unknown>; render: (r: unknown) => void };
