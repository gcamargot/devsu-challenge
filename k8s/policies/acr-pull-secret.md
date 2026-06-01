# ACR pull secret for Kyverno image verification (live, out-of-band)

The `verify-images` ClusterPolicy verifies the cosign (keyless) signature of our
own `devsu-challenge` images. The ACR `devsuacrgl5fdy.azurecr.io` is **private**
and its **admin user is disabled** (`admin_enabled = false`, see
`terraform/main.tf`).

The cluster nodes pull app images fine because the AKS **kubelet identity has
`AcrPull`** — but Kyverno's verification path does NOT run as the kubelet
identity. Kyverno pulls the image manifest + cosign signature artifact itself,
and with no registry creds it fails with:

```
failed to verify image ...: UNAUTHORIZED: authentication required
```

So Kyverno needs **its own registry credential**. We give it a `docker-registry`
Secret in the `kyverno` namespace and reference it from the policy rule via
`verifyImages[].imagePullSecrets: [acr-pull]`.

## What is codified vs. live-only

- **Codified** (`verify-images.yaml`): the rule references the Secret **by name**
  (`acr-pull`) under `verifyImages[].imagePullSecrets`. That name is the only
  contract between the policy and this Secret.
- **Live-only / out-of-band**: the `acr-pull` Secret itself. It holds an ACR
  **pull token/password**, which must NEVER be committed to git. Same philosophy
  as `k8s/overlays/aks-live/origin-ca-tls.md` — secrets that can't live safely in
  git are recorded here with the exact create commands + rollback.

> Where do `imagePullSecrets` for verifyImages go — policy or Kyverno config?
> **Both are valid.** Kyverno resolves verifyImages registry creds from EITHER:
> (a) the per-rule `verifyImages[].imagePullSecrets` field (secret names, looked
> up in the Kyverno namespace), OR (b) the global `imagePullSecrets` key in the
> `kyverno` ConfigMap / the controller's `--imagePullSecrets` flag.
> We use **(a)** because it is explicit and self-documenting in the policy, scopes
> the credential to this one rule, and survives Helm upgrades of Kyverno (which
> can rewrite the ConfigMap). Either way the **Secret must live in the `kyverno`
> namespace**. The global ConfigMap fallback is documented at the bottom.

---

## Live commands — RUN THESE YOURSELF (not run by Claude, no cluster access here)

Secret name (must match the policy): **`acr-pull`**
ACR: **`devsuacrgl5fdy`** (`devsuacrgl5fdy.azurecr.io`)
Repo scope: **`devsu-challenge`** (covers `devsu-challenge*`)

### 1. Create a pull-scoped ACR token (admin is disabled, so use a scope map)

```bash
ACR=devsuacrgl5fdy
REPO=devsu-challenge          # the repo the policy verifies (devsu-challenge*)
TOKEN_NAME=kyverno-verify-pull

# Token with a content/read (pull) scope on the devsu-challenge repo only.
# `az acr token create` auto-creates the scope-map with the given repo+action.
az acr token create \
  --registry "$ACR" \
  --name "$TOKEN_NAME" \
  --scope-map-actions content/read \
  --repository "$REPO" content/read \
  --status enabled

# Generate a password for the token (password1). Capture the value — it is shown
# ONCE. Optional --expiry-in-days for rotation.
TOKEN_PASSWORD=$(az acr token credential generate \
  --registry "$ACR" \
  --name "$TOKEN_NAME" \
  --password1 \
  --query 'passwords[0].value' -o tsv)
```

Notes:
- If your `az acr token create` rejects the inline `--repository ... content/read`
  on your CLI version, create the scope-map first, then the token:
  ```bash
  az acr scope-map create --registry "$ACR" --name kyverno-verify-pull-sm \
    --repository "$REPO" content/read
  az acr token create --registry "$ACR" --name "$TOKEN_NAME" \
    --scope-map kyverno-verify-pull-sm --status enabled
  ```
- The token **username** is the token name (`kyverno-verify-pull`); the
  **password** is `$TOKEN_PASSWORD`.

### 2. Create the docker-registry Secret in the `kyverno` namespace

```bash
export KUBECONFIG=/tmp/aks-devsu.kubeconfig   # or: az aks get-credentials -g devsu-rg -n devsu-aks --admin

kubectl -n kyverno create secret docker-registry acr-pull \
  --docker-server=devsuacrgl5fdy.azurecr.io \
  --docker-username=kyverno-verify-pull \
  --docker-password="$TOKEN_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 3. Re-apply the policy and confirm verification authenticates

```bash
kubectl apply -k k8s/policies

# Trigger an admission on a devsu-challenge pod (e.g. rollout restart) and check
# the policy reports no longer say UNAUTHORIZED. In Audit mode look at:
kubectl get policyreport -A | grep verify-images
kubectl -n kyverno logs deploy/kyverno-admission-controller | grep -i verifyimages
# A wrong/missing signature should now be the failure reason, NOT
# "authentication required".
```

## Rotation

```bash
TOKEN_PASSWORD=$(az acr token credential generate \
  --registry devsuacrgl5fdy --name kyverno-verify-pull --password1 \
  --query 'passwords[0].value' -o tsv)
kubectl -n kyverno create secret docker-registry acr-pull \
  --docker-server=devsuacrgl5fdy.azurecr.io \
  --docker-username=kyverno-verify-pull --docker-password="$TOKEN_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Rollback

```bash
kubectl -n kyverno delete secret acr-pull
az acr token delete --registry devsuacrgl5fdy --name kyverno-verify-pull
# and remove the imagePullSecrets block from verify-images.yaml if reverting.
```

## Alternative: global Kyverno config (NOT used here)

If you preferred the global form instead of the per-rule field, the same Secret
in the `kyverno` namespace is referenced from the `kyverno` ConfigMap:

```bash
kubectl -n kyverno patch configmap kyverno --type merge \
  -p '{"data":{"imagePullSecrets":"acr-pull"}}'
kubectl -n kyverno rollout restart deploy/kyverno-admission-controller
```

We chose the per-rule field in `verify-images.yaml` instead — see the note above.
