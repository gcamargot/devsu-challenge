# Observability: Off-cluster monitoring for AKS

Monitoring for the `devsu-aks` cluster using **Azure Monitor managed Prometheus** (metrics
store, fully managed) + **Azure Managed Grafana** (dashboards, fully managed). Both run
**off-cluster** so they do not consume the trial node pool (2x Standard_D2s_v3 = 4 vCPU, at
quota). Only a lightweight `ama-metrics` scrape agent + kube-state-metrics run in-cluster.

## Availability on the trial subscription

Verified **available** (NOT offer-restricted), unlike Front Door / managed PostgreSQL / B-series:

| Offering | Provider | Result |
|---|---|---|
| Azure Managed Grafana | `Microsoft.Dashboard` | Registered + created OK |
| Azure Monitor managed Prometheus | `Microsoft.Monitor` | Registered + created OK |
| Prometheus alert rules backing | `Microsoft.AlertsManagement` | Registered |

## What was provisioned (live, via az CLI)

Resource group `devsu-rg` / region `eastus2`:

- **Azure Monitor workspace** `devsu-amw` — managed Prometheus backend.
  - Prometheus query endpoint: `https://devsu-amw-e4fhbce5gycvepcm.eastus2.prometheus.monitor.azure.com`
  - Auto-created DCE/DCR live in the managed RG `MA_devsu-amw_eastus2_managed`.
- **AKS metrics add-on** enabled on `devsu-aks` (`az aks update --enable-azure-monitor-metrics`),
  pointed at `devsu-amw`. Adds in-cluster (kube-system): `ama-metrics` (2 replicas),
  `ama-metrics-ksm` (kube-state-metrics), `ama-metrics-node` (DaemonSet, cAdvisor/node).
- **Azure Managed Grafana** `devsu-grafana` (Standard SKU, Grafana 12), system-assigned identity.
  - URL: **https://devsu-grafana-hng2d6cze7fhh6ae.eus2.grafana.azure.com**
  - Linked to `devsu-amw` as the Prometheus datasource (uid `devsu-amw`), auto-granted
    `Monitoring Data Reader` on the workspace.

### Minimal-ingestion-profile tweak

The AKS add-on defaults to `minimalingestionprofile=true`, which **drops** `kube_pod_status_ready`
(it keeps `kube_pod_status_phase` and `kube_pod_container_status_restarts_total`). To get the
exact pod-readiness metric the dashboard uses, a ConfigMap adds it back on top of the minimal
profile (kept minimal for cost). See `kube-system/ama-metrics-settings-configmap` — captured in
`ama-metrics-settings-configmap.yaml` in this folder. After applying, the `ama-metrics` and
`ama-metrics-ksm` deployments were restarted to reload it; the metric appears ~3 min later.

## Access

The current signed-in user (`gastonmatiascamargo_gmail.com#EXT#@...`, objectId
`d94e1e26-ca6b-4161-aa63-9ba990419ffe`) was granted the **Grafana Admin** Azure role on the
Grafana instance. They log in at the URL above with their Entra ID (Azure AD) account — Managed
Grafana uses Entra SSO, no separate Grafana password. Grafana Admin lets them view AND edit.

To grant another viewer: `az role assignment create --assignee <upn|objectId> --role "Grafana Viewer" --scope <grafana-resource-id>`.

## Dashboard: "Devsu - Ephemeral Environments & App" (uid `devsu-envs`)

Shows, **per namespace** (template variable `$namespace`, defaults to all matching
`^(env-.*|devsu)$` — the ephemeral envs `env-<group>-<subdomain>` labelled
`provisioner.devsu.io/managed=true`, plus the main `devsu` app namespace):

- **Pods ready / total** — table + timeseries.
  `ready = sum by(namespace)(kube_pod_status_ready{condition="true"})`
  (falls back to `kube_pod_status_phase{phase="Running"}==1` if the ready metric isn't ingested),
  `total = count by(namespace)(kube_pod_info)`.
- **Pod restarts** — `increase(kube_pod_container_status_restarts_total[5m])` per namespace,
  plus a top-N restarting-containers table.
- **CPU usage** — `sum by(namespace)(rate(container_cpu_usage_seconds_total{container!=""}[5m]))` (cores).
- **Memory** — `sum by(namespace)(container_memory_working_set_bytes{container!=""})` (bytes).
- Overview stats: managed-env count, total pods, not-ready pods (red if >0), 15m restart count.

Source JSON: `dashboards/devsu-environments.json`. Azure also auto-provisions a full set of
built-in AKS dashboards in the same Grafana (Kubernetes / Compute Resources / Namespace (Pods),
Node Exporter, etc.) — those cover deeper drill-down for free.

### Re-import the dashboard

```sh
az grafana dashboard create -n devsu-grafana -g devsu-rg --overwrite true \
  --title "Devsu - Ephemeral Environments & App" \
  --definition @observability/dashboards/devsu-environments.json
```

## How the provisioner already surfaces status (the lightweight in-app view)

Independent of Grafana, the provisioner API exposes per-env readiness from the live k8s API
(`provisioner/src/kube.js` -> `envStatus()`: `{ pods, ready, phase }`). This is the
kubectl/jsonpath-style status that needs no extra infra and works even if Grafana is down.
Grafana adds history, CPU/mem, and cross-env comparison on top of it.

## Cost (approx, eastus2, USD)

- **Azure Managed Grafana (Standard):** ~$0.09/hour active-instance => **~$65/month** flat,
  plus a small per-active-user fee above the included seats (negligible for 1 admin).
- **Azure Monitor workspace / managed Prometheus:** pay-per-ingestion, ~$0.16 per million
  samples ingested + ~$0.10/GB-month query/retention. With the minimal profile on this tiny
  cluster (~a few thousand active series) this is roughly **$1-5/month**.
- **AKS metrics add-on:** no add-on fee; only the in-cluster agent's small CPU/mem (fits the quota).

Order of magnitude: **~$70/month**, dominated by the flat Grafana Standard instance fee.
For a pure demo, Grafana is the cost driver — tear it down when not in use.

## Teardown

Tear down with the rest of the stack:

```sh
az grafana delete -n devsu-grafana -g devsu-rg --yes
az aks update -g devsu-rg -n devsu-aks --disable-azure-monitor-metrics   # removes ama-metrics agent
az resource delete --ids $(az monitor account show -n devsu-amw -g devsu-rg --query id -o tsv)
# the auto-created managed RG MA_devsu-amw_eastus2_managed is removed with the workspace
az role assignment delete --assignee d94e1e26-ca6b-4161-aa63-9ba990419ffe \
  --role "Grafana Admin" --scope <grafana-resource-id>   # (gone once grafana is deleted)
```

Deleting `devsu-rg` removes everything in one shot (the managed RG goes with the workspace).

## IaC

`terraform/monitoring.tf` documents all of the above as `azurerm` resources
(`enable_monitoring` flag, default OFF). It was **authored but not applied** — the live
resources were created with az CLI per the task constraint (do not run terraform against the
repo). `terraform validate` + `terraform fmt -check` pass.
