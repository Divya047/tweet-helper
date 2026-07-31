declare const chrome: {
  storage?: { local?: { get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  runtime?: {
    onInstalled?: { addListener(callback: () => void): void };
    onMessage?: { addListener(callback: (message: any, sender: any, sendResponse: (response?: any) => void) => boolean | void): void };
    sendMessage(message: unknown): Promise<any>;
    sendNativeMessage?(applicationId: string, message: unknown): Promise<any>;
  };
  tabs?: {
    query?(query: { active?: boolean; currentWindow?: boolean }): Promise<Array<{ id?: number }>>;
    sendMessage?(tabId: number, message: unknown): Promise<any>;
    update?(tabId: number, update: { url?: string }): Promise<unknown>;
  };
  sidePanel?: {
    setPanelBehavior?(options: { openPanelOnActionClick: boolean }): Promise<void>;
    open?(options: { tabId: number }): Promise<void>;
  };
};
