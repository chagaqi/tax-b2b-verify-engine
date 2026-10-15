import type { Tenant } from './stores/types.js';

export type AppEnv = {
  Variables: {
    tenant: Tenant;
    requestId: string;
  };
};
