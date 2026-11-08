import { homedir } from "node:os";
import path from "node:path";

export const paseoHome = () => process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
export const ownerPolicyPath = (home = paseoHome()) => path.join(home, "owner", "policy.json");
export function legacyPublicConfigs(explicit?: string) {
  return [...new Set([explicit ?? process.env.PASEO_PUBLIC_CONFIG,
    path.join(homedir(), ".config", "paseo-public", "config.json")].filter((file): file is string => !!file))];
}
