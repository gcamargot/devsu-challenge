// Durable audit log. Every create/destroy action is appended as one JSON line
// (JSONL) to a file on a shared volume. On ACA that volume is an Azure Files share
// (mounted via `az containerapp env storage set` + a volume mount); the reaper
// CronJob in AKS mounts the *same* share through an Azure Files CSI PVC, so its
// deletions land in the same log. Falls back to a local path when no share is
// mounted (local dev), and degrades gracefully if the write fails — auditing must
// never block a provisioning action.
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const AUDIT_FILE = process.env.AUDIT_LOG_FILE || "/audit/audit.jsonl";

let dirReady = false;
async function ensureDir() {
  if (dirReady) return;
  try {
    await mkdir(dirname(AUDIT_FILE), { recursive: true });
  } catch {
    // The mount point usually already exists; ignore.
  }
  dirReady = true;
}

// Append one audit record. Fields: user, group, app, release, subdomain,
// namespace, action ("create" | "destroy"), result ("ok" | "error"), and an
// optional message. Timestamp and source are filled in here.
export async function audit(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    source: process.env.AUDIT_SOURCE || "provisioner",
    user: entry.user || "unknown",
    group: entry.group || "",
    app: entry.app || "",
    release: entry.release || "",
    subdomain: entry.subdomain || "",
    namespace: entry.namespace || "",
    action: entry.action || "",
    result: entry.result || "ok",
    message: entry.message || "",
  };
  try {
    await ensureDir();
    await appendFile(AUDIT_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    // Don't let a logging failure break the request; just surface it in stderr.
    console.error(`audit: failed to write entry (${err.message})`);
  }
  return record;
}

// Read the most recent `limit` entries (newest first). Returns [] if the log is
// empty or unreadable.
export async function recentAudit(limit = 100) {
  let raw;
  try {
    raw = await readFile(AUDIT_FILE, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip a truncated/garbled line rather than failing the whole read
    }
  }
  return entries.reverse().slice(0, limit);
}
