export interface SharerAccount {
  emailAddress: string;
  displayName: string;
  organizationName: string;
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
}
