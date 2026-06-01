import { spawn } from "node:child_process";

const KUBECTL = process.env.KUBECTL_BIN || "kubectl";

// Run kubectl, optionally feeding JSON/YAML on stdin. Resolves with stdout, rejects on non-zero.
function kubectl(args, stdin) {
  return new Promise((resolve, reject) => {
    const p = spawn(KUBECTL, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`kubectl ${args.join(" ")} failed (${code}): ${err || out}`));
    });
    if (stdin !== undefined) {
      p.stdin.write(stdin);
      p.stdin.end();
    }
  });
}

// Apply a list of manifest objects in one shot via a JSON List.
export async function applyManifests(objects) {
  const list = { apiVersion: "v1", kind: "List", items: objects };
  return kubectl(["apply", "-f", "-"], JSON.stringify(list));
}

export async function deleteNamespace(namespace) {
  return kubectl(["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"]);
}

// True if the namespace already exists (any namespace, not just managed ones).
export async function namespaceExists(namespace) {
  try {
    await kubectl(["get", "namespace", namespace, "-o", "name"]);
    return true;
  } catch {
    return false;
  }
}

// Cluster-wide scan: find the first ingress (any namespace) that already serves `host`
// in one of its rules. Returns "namespace/name" or null. We compare spec.rules[].host so
// a host taken by prod (e.g. devsu/devsu-demo) is caught before we apply anything.
export async function ingressOwningHost(host) {
  const out = await kubectl(["get", "ingresses", "--all-namespaces", "-o", "json"]);
  const items = JSON.parse(out).items || [];
  for (const ing of items) {
    const rules = ing.spec?.rules || [];
    if (rules.some((r) => r.host === host)) {
      return `${ing.metadata.namespace}/${ing.metadata.name}`;
    }
  }
  return null;
}

// List provisioner-managed namespaces with their metadata.
export async function listEnvs() {
  const out = await kubectl([
    "get",
    "namespaces",
    "-l",
    "provisioner.devsu.io/managed=true",
    "-o",
    "json",
  ]);
  const data = JSON.parse(out);
  return (data.items || []).map((ns) => {
    const a = ns.metadata.annotations || {};
    return {
      namespace: ns.metadata.name,
      status: ns.status?.phase,
      group: a["provisioner.devsu.io/group"],
      subdomain: a["provisioner.devsu.io/subdomain"],
      release: a["provisioner.devsu.io/release"],
      host: a["provisioner.devsu.io/host"],
      requestedBy: a["provisioner.devsu.io/requestedBy"],
      expiresAt: a["provisioner.devsu.io/expiresAt"],
      createdAt: ns.metadata.creationTimestamp,
    };
  });
}

// How many managed environments currently exist. Used to enforce the concurrency
// cap. We count namespaces that aren't already Terminating so a teardown in flight
// doesn't keep a slot pinned.
export async function countManagedEnvs() {
  const envs = await listEnvs();
  return envs.filter((e) => e.status !== "Terminating").length;
}

// Pod readiness summary for one env namespace: total pods, how many are Ready, and
// a coarse phase ("ready" once every pod is Ready, otherwise "pending"). Read live
// from the k8s API on each call.
export async function envStatus(namespace) {
  try {
    const out = await kubectl(["get", "pods", "-n", namespace, "-o", "json"]);
    const pods = JSON.parse(out).items || [];
    const ready = pods.filter((p) =>
      (p.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True")
    ).length;
    const phase = pods.length > 0 && ready === pods.length ? "ready" : "pending";
    return { pods: pods.length, ready, phase };
  } catch {
    return { pods: 0, ready: 0, phase: "unknown" };
  }
}
