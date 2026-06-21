import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CredentialPayload, OAuthCredentials, PlatformOps } from "./types";

const CRED_PATH = path.join(os.homedir(), ".claude", ".credentials.json");

const win32: PlatformOps = {
  async readOAuthCredentials(): Promise<OAuthCredentials> {
    const raw = await fs.promises.readFile(CRED_PATH, "utf8");
    const payload: CredentialPayload = JSON.parse(raw);
    return payload.claudeAiOauth;
  },

  async credentialsExist(): Promise<boolean> {
    return fs.existsSync(CRED_PATH);
  },

  async writeOAuthCredentials(payload: CredentialPayload): Promise<void> {
    fs.mkdirSync(path.dirname(CRED_PATH), { recursive: true });
    fs.writeFileSync(CRED_PATH, JSON.stringify(payload, null, 2));
  },

  async getSystemName(): Promise<string> {
    return os.hostname();
  },
};

export default win32;
