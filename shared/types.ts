export interface SharerAccount {
  emailAddress: string;
  displayName: string;
  organizationName: string;
}

// Optional Cloudflare Tunnel path — rides in the encrypted pairing blob so a
// receiver who got a Cloudflare connect URL learns the hostname (and, if the
// tunnel sits behind a Zero Trust Access app, the service token) without any
// out-of-band exchange. When present, the receiver runs `cloudflared access
// tcp` and dials the resulting local port instead of the hostname directly.
export interface CloudflareTunnelInfo {
  hostname: string;
  serviceTokenId?: string;
  serviceTokenSecret?: string;
}

// Wire format exchanged during pairing — produced by claude-share, consumed by claude-connect
export interface ConnectionFile {
  publicServerUrl: string | null;
  sessionId: string;
  sharedUntil: string; // ISO-8601
  caPem: string;
  sharerAccount: SharerAccount | null;
  systemName: string;
  proxyUser: string;
  proxyPass: string;
  cloudflare?: CloudflareTunnelInfo | null;
}
