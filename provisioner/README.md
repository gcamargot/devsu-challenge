# Devsu Self-Service Provisioner

A small htmx + Node/Express web app that lets anyone spin up an **ephemeral Users API
environment** on the shared AKS cluster, reachable at `<subdomain>.gcamargo.xyz`, with a
TTL after which it is automatically destroyed.

## Live URL

**https://provisioner.gcamargo.xyz** (behind Cloudflare; masks the ACA origin)

Origin: `https://provisioner.jollybeach-e34f00dd.eastus2.azurecontainerapps.io`

Deployed to **Azure Container Apps** (ACA) — Container App `provisioner` in resource group
`devsu-rg`, ACA environment `provisioner-env` (eastus2, Consumption profile), pulling the
image from ACR via the app's system-assigned managed identity (`AcrPull`). The public
`provisioner.gcamargo.xyz` name is an ACA custom domain with an ACA-managed TLS cert,
fronted by Cloudflare's proxy (zone `gcamargo.xyz`). See `infra/README.md` for the exact
Azure + Cloudflare steps.

## Hardening

- **Basic Auth** — the whole app (UI + API) is gated by HTTP Basic Auth (`src/auth.js`);
  the `devsu-admin` credential comes from `PROVISIONER_USER` / `PROVISIONER_PASSWORD` ACA
  secrets. `/health` and `/ready` stay open for probes. Unauthenticated requests get 401.
- **Concurrency limit** — at most `MAX_CONCURRENT_ENVS=3` managed environments; the 4th
  create is rejected with **HTTP 409**.
- **Persistent audit log** — every create/destroy (incl. reaper deletions) is appended as
  JSONL to a shared **Azure Files** share, mounted into both the ACA app and the AKS reaper
  CronJob. Visible at `/audit` (UI) and `/audit?format=json`.
- **Per-instance status** — the active-environments table reads live from the k8s API:
  pod readiness pill, TTL remaining, and the env URL.

## How the self-service flow works

1. **User fills the form** (htmx front-end): `group`, `app` (`users-api`), `release` (image
   tag, e.g. `sha-9948569` or `latest`), `subdomain` (default `devsu-prod`), `duration`
   (`30m`/`1h`/`4h`/`24h`).
2. **Submit → `POST /api/environments`.** The backend:
   - validates inputs (subdomain must be a DNS label, release a valid tag, duration ≤ 7d),
   - computes a namespace `env-<group>-<subdomain>` and host `<subdomain>.gcamargo.xyz`,
   - renders a full manifest set (Namespace, Secret, ConfigMap, in-cluster Postgres
     Deployment+Service, Users API Deployment+Service, Ingress, NetworkPolicies) and
     `kubectl apply`s it as a single JSON `List`,
   - annotates the namespace with `provisioner.devsu.io/expiresAt=<now+TTL>` (plus group,
     subdomain, release, host, requestedBy) and labels it `provisioner.devsu.io/managed=true`.
3. **Pods come up** and the app is served at `https://<subdomain>.gcamargo.xyz` via the
   shared `ingress-nginx` controller (public IP `20.98.237.230`). TLS is issued by the
   `selfsigned` ClusterIssuer (same as the current AKS demo overlay; swap to a Let's Encrypt
   issuer via the `CLUSTER_ISSUER` env var once the domain is delegated).
4. **The active-environments table** auto-refreshes (htmx polling every 15s) and shows pod
   readiness, expiry, and a **destroy** button (`DELETE /api/environments/:ns`).

### TTL reaper

A Kubernetes **CronJob** (`provisioner-system/provisioner-reaper`, every 5 min) runs
`node src/reaper.js` from the same image. It lists namespaces labelled
`provisioner.devsu.io/managed=true`, compares each `expiresAt` annotation to now, and
deletes the expired ones (a single `kubectl delete ns` tears the whole env down). It runs
in-cluster with a dedicated ServiceAccount + ClusterRole scoped to
`namespaces: get/list/delete` and `pods: get/list`. Apply once:

```sh
kubectl apply -f provisioner/k8s/reaper.yaml
```

## Why this provisioning mechanism (Option A)

The backend creates a **dedicated namespace per environment** and applies the app there.
This was chosen over triggering the GitHub CD workflow (Option B) because it is:

- **Self-contained & fast** — no dependency on a GitHub token with `actions:write`, no
  workflow queue latency; the env is applied directly and pods start in seconds.
- **Trivially reapable** — teardown is one `kubectl delete ns`; the TTL annotation lives on
  the namespace, so the reaper needs no external state.
- **Safe & isolated** — each env is its own namespace with its own Postgres, Secret, and
  default-deny NetworkPolicies; nothing touches the production `devsu` namespace.

### Kyverno compliance

Provisioner namespaces are **not** on Kyverno's exclusion list, so every pod we create
(Users API, Postgres, reaper) ships the hardened `securityContext`
(`runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, drop `ALL`
caps) and CPU/memory requests+limits. Postgres writes to emptyDir volumes for `PGDATA` and
`/var/run/postgresql` so it works with a read-only root FS. Resource requests are kept small
(app 100m/128Mi, pg 50m/128Mi, single replica each) because the cluster's two
`Standard_D2s_v3` nodes run near capacity.

## How the provisioner reaches AKS

- **On ACA:** the AKS admin kubeconfig is stored as an ACA **secret** (`kubeconfig`,
  base64-encoded) and mounted as a secret **volume** at `/kube/kubeconfig`. On startup
  `src/bootstrap.js` decodes it to `/tmp/kubeconfig` and points `KUBECONFIG` there.
- **On AKS (fallback / reaper):** in-cluster pods use the mounted ServiceAccount token
  automatically — no kubeconfig needed.

## Files

```
provisioner/
├── Dockerfile            # node:22-alpine + bundled kubectl, runs as UID 1000
├── package.json
├── package-lock.json
├── .dockerignore
├── public/index.html     # htmx single-page UI
├── src/
│   ├── server.js         # Express routes (form, list, create, delete, /audit) + auth gate
│   ├── auth.js           # HTTP Basic Auth middleware (creds from env/ACA secrets)
│   ├── audit.js          # JSONL audit log on the shared Azure Files mount
│   ├── manifests.js      # renders the per-env manifest set
│   ├── kube.js           # kubectl wrapper (apply / delete ns / list / status / count)
│   ├── ttl.js            # duration parsing → expiresAt
│   ├── reaper.js         # one-shot TTL reaper (run by the CronJob; audits deletions)
│   └── bootstrap.js      # decodes the base64 kubeconfig secret on ACA
├── k8s/
│   ├── reaper.yaml       # reaper CronJob + RBAC (apply once)
│   └── provisioner-aks.yaml  # AKS fallback Deployment/Service/Ingress + LB w/ cloudapp DNS label
└── infra/
    └── README.md         # az CLI commands that created the ACA resources
```

## Local development

```sh
cd provisioner
npm install
KUBECONFIG=/path/to/admin.kubeconfig CLUSTER_ISSUER=selfsigned \
  PROVISIONER_USER=devsu-admin PROVISIONER_PASSWORD='D3vsu-Ch4ll3ng3!' \
  AUDIT_LOG_FILE=./audit.jsonl MAX_CONCURRENT_ENVS=3 npm start
# open http://localhost:8080 (Basic Auth: devsu-admin / D3vsu-Ch4ll3ng3!)
```

## Hostname trade-off (cloudapp.azure.com)

The request was for a `provisioner.eastus2.cloudapp.azure.com` URL. That naming scheme is
**only** available on an Azure Public IP with a `dnsNameLabel` — ACA does not let you attach
one (its FQDN is fixed to `*.azurecontainerapps.io`, and custom domains require a CNAME +
managed cert you own). Since ACA was available and is the cleaner managed target, the
provisioner is deployed there and the working URL is the `azurecontainerapps.io` FQDN.

If you specifically need the `cloudapp.azure.com` name, deploy the AKS fallback in
`k8s/provisioner-aks.yaml`: it includes a dedicated `LoadBalancer` Service annotated with
`service.beta.kubernetes.io/azure-dns-label-name: provisioner`, which yields
`provisioner.eastus2.cloudapp.azure.com`.
