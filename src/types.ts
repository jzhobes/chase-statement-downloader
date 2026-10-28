export type ChaseApiMethod = 'GET' | 'POST';
export type DateFilter = 'CURRENT_YEAR' | `CURRENT_YEAR_MINUS_${number}`;
export type NavigationResult = 'login' | 'dashboard' | 'unsupported-browser' | 'timeout';

export interface ChaseApiOptions {
  method?: ChaseApiMethod;
  data?: string | null;
  headers?: Record<string, string>;
}

export interface MenuItem {
  accountId?: unknown;
  accountMask?: unknown;
  type?: unknown;
}

export interface CreditCardAccount {
  accountId: string;
  accountMask: string;
  type: 'BAC';
}

export interface DocRef {
  documentDate: string;
  documentId: string;
}

declare global {
  interface Window {
    csrfToken?: string;
    envConfig?: {
      csrfToken?: string;
    };
    JPMC?: {
      csrfToken?: string;
    };
  }
}

export {};
