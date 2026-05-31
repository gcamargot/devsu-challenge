// Renders the full set of manifests for one ephemeral Users API environment.
// Everything lives in a dedicated namespace so teardown is a single `kubectl delete ns`.
// Pods are Kyverno-compliant (requests/limits + hardened securityContext) because the
// provisioner namespaces are NOT on Kyverno's exclusion list.

const ACR = process.env.ACR_LOGIN_SERVER || "devsuacrgl5fdy.azurecr.io";
const DOMAIN = process.env.ENV_DOMAIN || "gcamargo.xyz";
const CLUSTER_ISSUER = process.env.CLUSTER_ISSUER || "selfsigned";

const labels = (name) => ({
  "app.kubernetes.io/name": name,
  "app.kubernetes.io/managed-by": "devsu-provisioner",
});

export function envNamespace(group, subdomain) {
  // RFC-1123 label: lowercase alphanumerics + dashes, <=63 chars
  const slug = `env-${group}-${subdomain}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/, "");
  return slug;
}

export function host(subdomain) {
  return `${subdomain}.${DOMAIN}`;
}

// Build the manifest list. `release` is the image tag, e.g. sha-9948569 or latest.
export function renderEnv({ namespace, host, release, group, subdomain, expiresAt, requestedBy }) {
  const image = `${ACR}/devsu-challenge:${release}`;

  const ns = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        ...labels("devsu-env"),
        "provisioner.devsu.io/managed": "true",
      },
      annotations: {
        "provisioner.devsu.io/expiresAt": expiresAt,
        "provisioner.devsu.io/group": group,
        "provisioner.devsu.io/subdomain": subdomain,
        "provisioner.devsu.io/release": release,
        "provisioner.devsu.io/host": host,
        "provisioner.devsu.io/requestedBy": requestedBy || "unknown",
      },
    },
  };

  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "devsu-demo-secret", namespace },
    stringData: { DB_USER: "devsu", DB_PASSWORD: "devsu-ephemeral" },
  };

  const configmap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "devsu-demo-config", namespace },
    data: {
      PORT: "8000",
      NODE_ENV: "production",
      DB_DIALECT: "postgres",
      DB_PORT: "5432",
      DB_NAME: "devsu",
      DB_HOST: "devsu-postgres",
    },
  };

  const hardenedCtx = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    capabilities: { drop: ["ALL"] },
  };

  const postgres = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "devsu-postgres", namespace, labels: labels("devsu-postgres") },
    spec: {
      replicas: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": "devsu-postgres" } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "devsu-postgres" } },
        spec: {
          securityContext: { runAsNonRoot: true, runAsUser: 70, fsGroup: 70, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "postgres",
              image: "postgres:16-alpine",
              ports: [{ containerPort: 5432 }],
              env: [
                { name: "POSTGRES_DB", value: "devsu" },
                { name: "POSTGRES_USER", valueFrom: { secretKeyRef: { name: "devsu-demo-secret", key: "DB_USER" } } },
                { name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "devsu-demo-secret", key: "DB_PASSWORD" } } },
                { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
              ],
              resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
              readinessProbe: { exec: { command: ["pg_isready", "-U", "devsu"] }, periodSeconds: 5 },
              securityContext: hardenedCtx,
              volumeMounts: [
                { name: "data", mountPath: "/var/lib/postgresql/data" },
                { name: "run", mountPath: "/var/run/postgresql" },
              ],
            },
          ],
          volumes: [
            { name: "data", emptyDir: {} },
            { name: "run", emptyDir: {} },
          ],
        },
      },
    },
  };

  const postgresSvc = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "devsu-postgres", namespace },
    spec: {
      selector: { "app.kubernetes.io/name": "devsu-postgres" },
      ports: [{ port: 5432, targetPort: 5432 }],
    },
  };

  const app = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "devsu-demo", namespace, labels: labels("devsu-demo") },
    spec: {
      replicas: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": "devsu-demo" } },
      strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "devsu-demo" } },
        spec: {
          securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "app",
              image,
              ports: [{ name: "http", containerPort: 8000 }],
              envFrom: [
                { configMapRef: { name: "devsu-demo-config" } },
                { secretRef: { name: "devsu-demo-secret" } },
              ],
              resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
              startupProbe: { httpGet: { path: "/health", port: "http" }, failureThreshold: 30, periodSeconds: 2 },
              livenessProbe: { httpGet: { path: "/health", port: "http" }, periodSeconds: 10 },
              readinessProbe: { httpGet: { path: "/ready", port: "http" }, periodSeconds: 10 },
              securityContext: hardenedCtx,
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: {} }],
        },
      },
    },
  };

  const appSvc = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "devsu-demo", namespace, labels: labels("devsu-demo") },
    spec: {
      type: "ClusterIP",
      selector: { "app.kubernetes.io/name": "devsu-demo" },
      ports: [{ name: "http", port: 80, targetPort: "http" }],
    },
  };

  const ingress = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: "devsu-demo",
      namespace,
      annotations: { "cert-manager.io/cluster-issuer": CLUSTER_ISSUER },
    },
    spec: {
      ingressClassName: "nginx",
      tls: [{ hosts: [host], secretName: "devsu-demo-tls" }],
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: { service: { name: "devsu-demo", port: { number: 80 } } },
              },
            ],
          },
        },
      ],
    },
  };

  // NetworkPolicies: default-deny is added automatically by Kyverno's
  // add-default-networkpolicy policy, so we explicitly allow ingress->app and app->pg.
  const npApp = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "devsu-demo", namespace },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": "devsu-demo" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" } } }],
          ports: [{ protocol: "TCP", port: 8000 }],
        },
      ],
    },
  };

  const npPg = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "devsu-postgres", namespace },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": "devsu-postgres" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "devsu-demo" } } }],
          ports: [{ protocol: "TCP", port: 5432 }],
        },
      ],
    },
  };

  return [ns, secret, configmap, postgres, postgresSvc, app, appSvc, ingress, npApp, npPg];
}
