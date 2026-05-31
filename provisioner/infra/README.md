# Provisioner infra (Azure CLI)

The provisioner is deployed to Azure Container Apps via the `az` CLI (not the main
Terraform state, which is owned/applied elsewhere). These are the commands that created the
live resources, kept here for reproducibility.

```sh
RG=devsu-rg
LOC=eastus2
ACR=devsuacrgl5fdy.azurecr.io
TAG=sha-XXXXXXXXXX   # output of the build

# 1. Provider + extension (one-time; trial subs start NotRegistered)
az provider register -n Microsoft.App
az provider register -n Microsoft.OperationalInsights
az extension add -n containerapp

# 2. Build + push the image
az acr login -n devsuacrgl5fdy
docker build -t $ACR/provisioner:$TAG provisioner/
docker push $ACR/provisioner:$TAG

# 3. ACA environment (Consumption profile, no Log Analytics to keep the trial light)
az containerapp env create \
  --name provisioner-env --resource-group $RG --location $LOC \
  --logs-destination none

# 4. Container App: system identity + AcrPull, external ingress on :8080
az containerapp create \
  --name provisioner --resource-group $RG --environment provisioner-env \
  --image $ACR/provisioner:$TAG \
  --registry-server $ACR --registry-identity system \
  --target-port 8080 --ingress external \
  --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
  --env-vars CLUSTER_ISSUER=selfsigned ENV_DOMAIN=gcamargo.xyz

# 5. Give the app the AKS admin kubeconfig as a mounted secret volume.
#    Store base64 (multiline YAML is awkward as a raw CLI secret); the app decodes it
#    on startup (src/bootstrap.js) and points KUBECONFIG at the decoded file.
az containerapp secret set -n provisioner -g $RG \
  --secrets "kubeconfig=$(base64 -w0 /path/to/aks-admin.kubeconfig)"

#    Then add the secret volume + mount + KUBECONFIG_B64_FILE env via the app YAML:
az containerapp show -n provisioner -g $RG -o yaml > app.yaml
#    edit app.yaml:
#      properties.template.volumes:
#        - name: kube
#          storageType: Secret
#          secrets: [{ secretRef: kubeconfig, path: kubeconfig }]
#      properties.template.containers[0].volumeMounts:
#        - { volumeName: kube, mountPath: /kube }
#      properties.template.containers[0].env: add { name: KUBECONFIG_B64_FILE, value: /kube/kubeconfig }
az containerapp update -n provisioner -g $RG --yaml app.yaml

# 6. Get the public URL
az containerapp show -n provisioner -g $RG \
  --query properties.configuration.ingress.fqdn -o tsv
```

## Hardening (auth, concurrency, audit, status, custom domain)

### Basic Auth (point 1)

The whole app (UI + API) is gated behind HTTP Basic Auth (`src/auth.js`). The single
admin credential is read from `PROVISIONER_USER` / `PROVISIONER_PASSWORD`, stored as ACA
secrets (never baked into the image). `/health` and `/ready` stay open for probes.

```sh
az containerapp secret set -n provisioner -g $RG \
  --secrets "provisioner-user=devsu-admin" "provisioner-password=D3vsu-Ch4ll3ng3!"
# then reference them as secretRef env vars PROVISIONER_USER / PROVISIONER_PASSWORD
```

### Concurrency limit (point 2)

`MAX_CONCURRENT_ENVS=3` (env var). Before creating, the backend counts non-Terminating
namespaces labelled `provisioner.devsu.io/managed=true`; at the cap it returns **HTTP 409**
with a clear message instead of creating a 4th.

### Persistent audit log on Azure Files (point 3)

Every create/destroy is appended as JSONL to a shared **Azure Files** share, mounted into
both the ACA app (`/audit`) and the AKS reaper CronJob (`/audit`, via the Azure Files CSI).
Recent entries are exposed at `/audit` (HTML) and `/audit?format=json` (behind auth).

```sh
SA=devsuprovstorgl5fdy           # storage account (Standard_LRS, StorageV2)
SHARE=provisioner-audit          # file share, 5 GiB quota
az storage account create -n $SA -g $RG -l $LOC --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false
KEY=$(az storage account keys list -n $SA -g $RG --query '[0].value' -o tsv)
az storage share create --name $SHARE --account-name $SA --account-key "$KEY" --quota 5

# register the share in the ACA environment, then mount it into the app
az containerapp env storage set --name provisioner-env -g $RG \
  --storage-name auditshare --azure-file-account-name $SA \
  --azure-file-account-key "$KEY" --azure-file-share-name $SHARE --access-mode ReadWrite
# app.yaml: add volume {name: audit, storageType: AzureFile, storageName: auditshare}
# + volumeMount {volumeName: audit, mountPath: /audit}
# + env AUDIT_LOG_FILE=/audit/audit.jsonl, AUDIT_SOURCE=provisioner

# the reaper in AKS mounts the SAME share via a static PV/PVC (see ../k8s/reaper.yaml);
# its account key lives in a k8s Secret in provisioner-system:
kubectl -n provisioner-system create secret generic provisioner-audit-azurefile \
  --from-literal=azurestorageaccountname=$SA \
  --from-literal=azurestorageaccountkey="$KEY"
```

### Per-instance status (point 4)

The active-environments table reads live from the k8s API: a readiness pill
(`<ready>/<pods> ready`), the TTL remaining (`Xh Ym left`), and the env URL.

### Custom domain via Cloudflare (point 5)

`https://provisioner.gcamargo.xyz` fronts the ACA app, masking the
`*.azurecontainerapps.io` FQDN behind Cloudflare's proxy.

```sh
ASUID=$(az containerapp show -n provisioner -g $RG \
  --query properties.customDomainVerificationId -o tsv)
ACA_FQDN=$(az containerapp show -n provisioner -g $RG \
  --query properties.configuration.ingress.fqdn -o tsv)

# Cloudflare (zone gcamargo.xyz): asuid validation TXT + the app CNAME.
# Create the CNAME DNS-only FIRST so ACA's managed-cert CNAME validation can resolve
# straight to the ACA FQDN (a proxied record would hand back Cloudflare IPs and the
# validation gets finicky).
#   TXT   asuid.provisioner  -> $ASUID            (proxied=false)
#   CNAME provisioner        -> $ACA_FQDN         (proxied=false  <-- for validation)

# bind the ACA managed cert (CNAME control validation)
az containerapp hostname add  -n provisioner -g $RG --hostname provisioner.gcamargo.xyz
az containerapp hostname bind -n provisioner -g $RG --hostname provisioner.gcamargo.xyz \
  --environment provisioner-env --validation-method CNAME
# (the bind CLI may hang on its final poll; the binding still completes — verify with
#  `az containerapp show ... --query properties.configuration.ingress.customDomains`,
#  bindingType should be SniEnabled, and the managed cert provisioningState=Succeeded.)

# once the managed cert is Succeeded, flip the CNAME to proxied=true so Cloudflare masks
# the origin. SSL mode "Full" works because the ACA origin presents a real public cert
# for provisioner.gcamargo.xyz (Full strict would also work for the same reason).
```

## Notes

- **Security:** baking the AKS *admin* kubeconfig into an ACA secret is the pragmatic
  take-home choice. For production, prefer a dedicated ServiceAccount token with the scoped
  ClusterRole from `../k8s/provisioner-aks.yaml` (RBAC limited to namespaces + the resources
  the provisioner manages), or run the provisioner in-cluster (the AKS fallback) so it uses a
  mounted SA token and no long-lived admin credential leaves the cluster.
- **ACA availability:** confirmed working in `eastus2` on this trial sub (Consumption
  profile). This is notable because `Standard_B`-series VMs are blocked for AKS and Azure
  PostgreSQL Flexible is `LocationIsOfferRestricted` here — ACA was *not* restricted.
- **Teardown:** `az containerapp delete -n provisioner -g devsu-rg --yes` and
  `az containerapp env delete -n provisioner-env -g devsu-rg --yes`.
