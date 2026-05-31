# Edge-to-origin TLS: Cloudflare Full (strict) with a Cloudflare Origin CA cert

The public path is `client -> Cloudflare edge (proxied) -> ingress-nginx LB
(20.98.237.230) -> devsu-demo`. This documents hardening the **edge-to-origin**
leg from Cloudflare SSL mode **Full** to **Full (strict)**.

- **Full**: CF encrypts to the origin but does NOT validate the origin cert (a
  self-signed cert is accepted). Vulnerable to an on-path attacker between CF and
  the origin.
- **Full (strict)**: CF validates the origin cert. A **Cloudflare Origin CA**
  certificate is trusted by Cloudflare for origin pulls (it is NOT publicly
  trusted — browsers never see it, since CF terminates the public TLS).

So the origin Ingress must present a Cloudflare Origin CA cert, not the
cert-manager `selfsigned` one.

## What is codified vs. live-only

- **Codified** (`patch-ingress.yaml`): the Ingress points `tls.secretName` at
  `devsu-origin-tls` and DELETES the `cert-manager.io/cluster-issuer` annotation
  inherited from the `local-kind` base (strategic-merge `~`), so cert-manager
  stops managing/overwriting the TLS secret.
- **Live-only / out-of-band**: the `devsu-origin-tls` Secret itself. It holds the
  Origin CA **private key**, which must NEVER be committed to git. It is created
  directly against the cluster (below). Same philosophy as
  `svc-externaltrafficpolicy.md`: things that can't live safely in git are
  recorded here with the exact commands + rollback.

## Cloudflare zone

- Zone `gcamargo.xyz`, id `59d1d44b6767d59a0363ccf1e354359a`.
- Origin host: `devsu-prod.gcamargo.xyz` (covered by the `*.gcamargo.xyz` SAN).

## How the Origin CA cert was created (via API)

The Cloudflare Origin CA endpoint historically requires the account-level
"Origin CA Key" rather than a scoped API token, but in this case the scoped
**Bearer token was accepted** (HTTP 200). Flow:

```bash
umask 077
# 1. private key + CSR (CN apex, SANs apex + wildcard)
openssl req -new -newkey rsa:2048 -nodes \
  -keyout origin.key -out origin.csr \
  -subj "/CN=gcamargo.xyz" \
  -addext "subjectAltName=DNS:gcamargo.xyz,DNS:*.gcamargo.xyz"

# 2. POST the CSR to the Origin CA endpoint (origin-rsa, 15y validity)
#    body = {"hostnames":["gcamargo.xyz","*.gcamargo.xyz"],
#            "requested_validity":5475,"request_type":"origin-rsa","csr":"<PEM>"}
curl -sS -X POST 'https://api.cloudflare.com/client/v4/certificates' \
  -H "Authorization: Bearer <CF_TOKEN>" \
  -H 'Content-Type: application/json' \
  --data @cf-body.json
# -> result.certificate is the signed Origin CA cert PEM. Save it to origin.crt.
```

Resulting cert: issuer `CloudFlare Origin SSL Certificate Authority`, subject CN
`CloudFlare Origin Certificate`, SANs `*.gcamargo.xyz` + `gcamargo.xyz`, valid
`2026-05-31` -> `2041-05-27`. Verify the key matches the cert:

```bash
diff <(openssl rsa  -in origin.key -noout -modulus) \
     <(openssl x509 -in origin.crt -noout -modulus) && echo MATCH
```

> If the token had been rejected with an auth error, the fallback is to create the
> cert in the dashboard: **SSL/TLS -> Origin Server -> Create Certificate**
> (RSA, hostnames `gcamargo.xyz` + `*.gcamargo.xyz`, 15y), then copy the cert PEM
> into `origin.crt` and the private key PEM into `origin.key` and continue below.

## Install on the ingress (live, out-of-band)

```bash
export KUBECONFIG=/tmp/aks-devsu.kubeconfig
# private key only ever lives in this Secret, never in git
kubectl -n devsu create secret tls devsu-origin-tls \
  --cert=origin.crt --key=origin.key \
  --dry-run=client -o yaml | kubectl apply -f -
```

The Ingress changes are codified in `patch-ingress.yaml` (re-applied via
`kubectl apply -k k8s/overlays/aks-live`). Applied live as:

```bash
kubectl -n devsu annotate ingress devsu-demo cert-manager.io/cluster-issuer-
kubectl -n devsu patch ingress devsu-demo --type=json \
  -p='[{"op":"replace","path":"/spec/tls/0/secretName","value":"devsu-origin-tls"}]'
```

## Switch Cloudflare to Full (strict)

```bash
curl -sS -X PATCH \
  'https://api.cloudflare.com/client/v4/zones/59d1d44b6767d59a0363ccf1e354359a/settings/ssl' \
  -H "Authorization: Bearer <CF_TOKEN>" \
  -H 'Content-Type: application/json' \
  --data '{"value":"strict"}'
```

## Verification

In-cluster (sandbox cannot reach the public endpoint): confirm the controller
serves the Origin CA cert for the host (Kyverno requires resources +
non-root/read-only-rootfs securityContext on the probe pod):

```bash
echo | openssl s_client \
  -connect ingress-nginx-controller.ingress-nginx.svc.cluster.local:443 \
  -servername devsu-prod.gcamargo.xyz 2>/dev/null \
  | openssl x509 -noout -issuer -subject
# expect issuer: CloudFlare Origin SSL Certificate Authority
#        subject CN: CloudFlare Origin Certificate
```

Human-side (real public path, run from a workstation):

```bash
curl -sS -D- -o /dev/null https://devsu-prod.gcamargo.xyz/api/
# expect HTTP/2 200 and a `cf-ray:` response header (proves it went through CF
# and CF accepted the origin cert under strict).
```

## Rollback (if strict breaks the path)

```bash
# 1. Cloudflare SSL mode back to Full
curl -sS -X PATCH \
  'https://api.cloudflare.com/client/v4/zones/59d1d44b6767d59a0363ccf1e354359a/settings/ssl' \
  -H "Authorization: Bearer <CF_TOKEN>" -H 'Content-Type: application/json' \
  --data '{"value":"full"}'

# 2. Ingress back to the cert-manager self-signed secret
kubectl -n devsu patch ingress devsu-demo --type=json \
  -p='[{"op":"replace","path":"/spec/tls/0/secretName","value":"devsu-demo-tls"}]'
kubectl -n devsu annotate ingress devsu-demo \
  cert-manager.io/cluster-issuer=selfsigned --overwrite
```

The original cert-manager `Certificate` `devsu-demo-tls` and its secret were left
in place, so rollback is immediate. (And revert this overlay's `patch-ingress.yaml`.)
