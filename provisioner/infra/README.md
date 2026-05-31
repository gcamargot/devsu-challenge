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
