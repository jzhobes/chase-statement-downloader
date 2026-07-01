export type ChaseApiMethod = 'GET' | 'POST';
export type DateFilter = 'CURRENT_YEAR' | `CURRENT_YEAR_MINUS_${number}`;
export type NavigationResult = 'login' | 'dashboard' | 'timeout';

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

export interface MenuListResponse {
  items?: MenuItem[];
}

export interface DocRef {
  documentDate: string;
  documentId: string;
}

export interface StatementListResponse {
  idaldocRefs?: DocRef[];
}

export interface DocKeyRef {
  docKey?: string;
}

export interface DocKeyResponse {
  csrftoken?: string;
  docKey?: string;
  idaldockeyRefs?: DocKeyRef[];
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
