// On ACA the kubeconfig is delivered as a base64-encoded secret mounted at a path
// (multiline YAML is awkward to pass through the CLI as a raw secret). If
// KUBECONFIG_B64_FILE points at such a file, decode it once into a real kubeconfig
// and repoint KUBECONFIG at it. No-op when running with a plain KUBECONFIG (local/AKS).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function bootstrapKubeconfig() {
  const src = process.env.KUBECONFIG_B64_FILE;
  if (!src || !existsSync(src)) return;
  const dest = process.env.KUBECONFIG_DECODED || "/tmp/kubeconfig";
  const decoded = Buffer.from(readFileSync(src, "utf8"), "base64").toString("utf8");
  writeFileSync(dest, decoded, { mode: 0o600 });
  process.env.KUBECONFIG = dest;
  console.log(`kubeconfig decoded from ${src} → ${dest}`);
}
