// TTL reaper: deletes provisioner-managed namespaces whose expiresAt has passed.
// Run as a one-shot (Kubernetes CronJob) — `node src/reaper.js`.
import { bootstrapKubeconfig } from "./bootstrap.js";
import { listEnvs, deleteNamespace } from "./kube.js";

bootstrapKubeconfig();

async function main() {
  const now = Date.now();
  const envs = await listEnvs();
  if (!envs.length) {
    console.log("reaper: no managed environments");
    return;
  }
  let reaped = 0;
  for (const e of envs) {
    const exp = e.expiresAt ? Date.parse(e.expiresAt) : NaN;
    if (Number.isFinite(exp) && exp <= now) {
      console.log(`reaper: ${e.namespace} expired at ${e.expiresAt} → deleting`);
      await deleteNamespace(e.namespace);
      reaped++;
    } else {
      console.log(`reaper: ${e.namespace} expires ${e.expiresAt} (keep)`);
    }
  }
  console.log(`reaper: done, deleted ${reaped} expired environment(s)`);
}

main().catch((err) => {
  console.error("reaper failed:", err.message);
  process.exit(1);
});
