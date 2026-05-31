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

// Pod readiness summary for one env namespace.
export async function envStatus(namespace) {
  try {
    const out = await kubectl(["get", "pods", "-n", namespace, "-o", "json"]);
    const pods = JSON.parse(out).items || [];
    const ready = pods.filter((p) =>
      (p.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True")
    ).length;
    return { pods: pods.length, ready };
  } catch {
    return { pods: 0, ready: 0 };
  }
}
