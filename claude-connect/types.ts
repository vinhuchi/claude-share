import type { SharerAccount } from "@shared/types";

export type { ConnectionFile, SharerAccount } from "@shared/types";

export interface SavedConnection {
  id: string;
  systemName: string;
  publicServerUrl: string | null;
  sessionId: string;
  sharedUntil: string; // ISO-8601 — used to prune expired connections on startup
  caPem: string;
  savedAt: string;
  sharerAccount: SharerAccount | null;
  proxyUser: string;
  proxyPass: string;
}

export interface ReceiverConfig {
  deviceName: string;
  hasConnectTermsAgreed?: boolean;
}
