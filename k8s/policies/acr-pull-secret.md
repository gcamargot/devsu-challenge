# ACR pull secret for Kyverno image verification (live, out-of-band)

The `verify-images` ClusterPolicy verifies the keyless cosign signature of our
`devsu-challenge` images. The ACR `devsuacrgl5fdy.azurecr.io` is **private** and
its **admin user is disabled** (`admin_enabled = false`, see `terraform/main.tf`).

The cluster nodes pull app images because the AKS **kubelet identity has
`AcrPull`** — but Kyverno's verification path does NOT run as the kubelet
identity. It pulls the image manifest + the cosign signature artifact itself, and
without registry creds it fails with:

```
failed to verify image ...: UNAUTHORIZED: authentication required
```

So Kyverno needs **its own registry credential**: a `docker-registry` Secret in
the `kyverno` namespace, wired as the controllers' global image-pull secret.

## Where the credential is configured (important)

In this Kyverno version (v1.18) the credential is **global**, set via the
controller flag `--imagePullSecrets=<secret>` — there is **no per-rule
`verifyImages[].imagePullSecrets` field** (the ClusterPolicy CRD rejects it with
`strict decoding error: unknown field`). So the policy YAML only references the
image repos; the credential lives on the Kyverno controllers.

- **Codified**: `scripts/bootstrap-addons.sh` installs Kyverno with
  `--set "config.imagePullSecrets={acr-pull}"`, which renders the
  `--imagePullSecrets=acr-pull` flag on the controllers.
- **Live-only / out-of-band**: the `acr-pull` Secret itself (holds an ACR pull
  token). Never committed to git — same philosophy as
  `k8s/overlays/aks-live/origin-ca-tls.md`.

The secret name (`acr-pull`) is the only contract between the flag and the Secret.

## Create the secret (live)

ACR admin is disabled, so mint a repository-scoped pull token:

```bash
ACR=devsuacrgl5fdy
TOKEN_NAME=kyverno-verify-pull

# Pull-only token scoped to the devsu-challenge repo (covers the image and its
# cosign .sig artifact, which lives under the same repo).
az acr token create -n "$TOKEN_NAME" -r "$ACR" \
  --repository devsu-challenge content/read --status enabled

TOKEN_PASSWORD=$(az acr token credential generate -n "$TOKEN_NAME" -r "$ACR" \
  --password1 --query 'passwords[0].value' -o tsv)

# docker-registry Secret in the kyverno namespace (username = token name).
kubectl -n kyverno create secret docker-registry acr-pull \
  --docker-server="${ACR}.azurecr.io" \
  --docker-username="$TOKEN_NAME" \
  --docker-password="$TOKEN_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Wire it onto the controllers (live)

Fresh installs get it from `bootstrap-addons.sh`. On a cluster already running
Kyverno, patch the two controllers that verify images and roll them:

```bash
for d in kyverno-admission-controller kyverno-reports-controller; do
  kubectl -n kyverno patch deploy "$d" --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--imagePullSecrets=acr-pull"}]'
done
kubectl -n kyverno rollout status deploy/kyverno-admission-controller
```

(The `add ...args/-` patch appends, so run it only once per controller.)

## Verify

```bash
kubectl -n devsu rollout restart deploy/devsu-demo
kubectl -n devsu get policyreport -o wide   # verify-images rules -> pass / "image verified"
```

Kyverno logs should show `image attestors verification succeeded ... verifiedCount=1`
and no `UNAUTHORIZED`.

> Note: `verify-images.yaml` keeps `verifyDigest: false` while in **Audit** because
> images deploy by tag and Kyverno can't mutate to a digest in audit-only mode;
> requiring a digest would fail ("missing digest") even on a correctly-signed
> image. Flip `verifyDigest: true` together with `mutateDigest: true` at the
> Enforce cutover so images get pinned to their verified digest.

## Rollback

```bash
az acr token delete -n kyverno-verify-pull -r devsuacrgl5fdy
kubectl -n kyverno delete secret acr-pull
# remove the --imagePullSecrets=acr-pull arg from both controllers (kubectl edit)
```
