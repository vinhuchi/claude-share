import type { CloudflareTunnelInfo, SharerAccount } from "@shared/types";

export type {
  CloudflareTunnelInfo,
  ConnectionFile,
  SharerAccount,
} from "@shared/types";

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
  // Present when this share is reached via a Cloudflare Tunnel — the receiver
  // re-runs `cloudflared access tcp` with this on every (re)connect.
  cloudflare?: CloudflareTunnelInfo | null;
}

export interface ReceiverConfig {
  deviceName: string;
}
