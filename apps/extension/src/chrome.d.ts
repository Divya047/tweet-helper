declare const chrome:
  | undefined
  | {
      storage?: {
        local?: {
          get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
          set(items: Record<string, unknown>): Promise<void>;
        };
      };
      runtime?: {
        onInstalled?: {
          addListener(callback: () => void): void;
        };
      };
    };
