# ingress-nginx Service: externalTrafficPolicy=Local (Cloudflare origin lockdown)

The app Ingress is locked to Cloudflare source ranges via
`nginx.ingress.kubernetes.io/whitelist-source-range` (see `patch-ingress.yaml`).

That allowlist matches on the **TCP source IP** that reaches nginx. With the
ingress-nginx Service in its default `externalTrafficPolicy: Cluster`, the Azure
Load Balancer SNATs the packet to a node's internal IP before it hits the
controller pod, so nginx sees `10.224.0.x` (the LB/node), never the real
Cloudflare PoP. The allowlist would then reject **everything**.

Setting `externalTrafficPolicy: Local` makes the Azure LB forward to the
controller's node without SNAT, preserving the original client (Cloudflare PoP)
source IP. That is what the whitelist evaluates.

This is NOT managed by kustomize because the Service is owned by the
ingress-nginx Helm release (namespace `ingress-nginx`, outside this overlay).
The proper long-term home is the Helm values
(`controller.service.externalTrafficPolicy: Local`); it is applied live here as
a one-off patch and recorded in this file so it is not lost.

## Live change applied (2026-05-31)

```bash
kubectl -n ingress-nginx patch svc ingress-nginx-controller \
  -p '{"spec":{"externalTrafficPolicy":"Local"}}'
```

Equivalent persistent change in the ingress-nginx Helm values:

```yaml
controller:
  service:
    externalTrafficPolicy: Local
```

### Operational note (Local + LB health probes)

With `Local`, the Azure LB only routes to nodes that actually run a controller
pod (it uses the kube-proxy `healthCheckNodePort` to probe each node). Today the
controller runs as a 1-replica Deployment, so only the node hosting that pod is
"healthy" at the LB — fine, but if that pod moves, traffic follows it once the
LB probe converges (a few seconds). For HA, run the controller as a DaemonSet or
scale it to >=2 replicas (one per node) so every node passes the probe. This is
a resiliency note, not a blocker for the lockdown.

`use-forwarded-headers` / `CF-Connecting-IP` are NOT required for the allowlist
(the allowlist is L3/L4 source-IP based, handled by `Local`). They only matter
if you want the *application* logs / `X-Forwarded-For` to show the real visitor
IP. Left at defaults here.

## Rollback

Revert the Service to default routing (disables real-source-IP preservation,
which in turn makes the whitelist see the LB SNAT IP and block everything — so
roll back the Ingress annotation **too** if you roll this back):

```bash
kubectl -n ingress-nginx patch svc ingress-nginx-controller \
  -p '{"spec":{"externalTrafficPolicy":"Cluster"}}'
```

Remove the origin allowlist (open the origin to the world again):

```bash
kubectl -n devsu annotate ingress devsu-demo \
  nginx.ingress.kubernetes.io/whitelist-source-range-
```

(or revert `patch-ingress.yaml` and re-apply the overlay).
