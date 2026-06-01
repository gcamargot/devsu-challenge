# Infra del provisioner (Azure CLI)

El provisioner se despliega a Azure Container Apps con la CLI `az`, aparte del Terraform
principal. Estos son los comandos que crearon los recursos, dejados acá como registro de
reproducibilidad.

Contexto y diseño: https://gcamargot.github.io/devsu-challenge/Procedimiento-6-provisioner/

```sh
RG=devsu-rg
LOC=eastus2
ACR=devsuacrgl5fdy.azurecr.io
TAG=sha-XXXXXXXXXX

# 1. Provider + extensión (one-time)
az provider register -n Microsoft.App
az provider register -n Microsoft.OperationalInsights
az extension add -n containerapp

# 2. Build + push de la imagen
az acr login -n devsuacrgl5fdy
docker build -t $ACR/provisioner:$TAG provisioner/
docker push $ACR/provisioner:$TAG

# 3. Container Apps Environment (perfil Consumption)
az containerapp env create \
  --name provisioner-env --resource-group $RG --location $LOC \
  --logs-destination none

# 4. Container App: identidad system + AcrPull, ingress externo en :8080
az containerapp create \
  --name provisioner --resource-group $RG --environment provisioner-env \
  --image $ACR/provisioner:$TAG \
  --registry-server $ACR --registry-identity system \
  --target-port 8080 --ingress external \
  --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
  --env-vars CLUSTER_ISSUER=selfsigned ENV_DOMAIN=gcamargo.xyz

# 5. Kubeconfig de AKS como secret + volumen montado (la app lo decodifica al iniciar)
az containerapp secret set -n provisioner -g $RG \
  --secrets "kubeconfig=$(base64 -w0 /ruta/al/aks-admin.kubeconfig)"

az containerapp show -n provisioner -g $RG -o yaml > app.yaml
#   editar app.yaml:
#     properties.template.volumes:
#       - { name: kube, storageType: Secret, secrets: [{ secretRef: kubeconfig, path: kubeconfig }] }
#     properties.template.containers[0].volumeMounts:
#       - { volumeName: kube, mountPath: /kube }
#     properties.template.containers[0].env: agregar { name: KUBECONFIG_B64_FILE, value: /kube/kubeconfig }
az containerapp update -n provisioner -g $RG --yaml app.yaml

# 6. Credenciales de Basic Auth como secrets
az containerapp secret set -n provisioner -g $RG \
  --secrets "provisioner-user=devsu-admin" "provisioner-password=<password>"
# luego referenciarlos como env vars secretRef PROVISIONER_USER / PROVISIONER_PASSWORD

# 7. Audit log en Azure Files, montado en la app y en el reaper de AKS
SA=devsuprovstorgl5fdy
SHARE=provisioner-audit
az storage account create -n $SA -g $RG -l $LOC --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false
KEY=$(az storage account keys list -n $SA -g $RG --query '[0].value' -o tsv)
az storage share create --name $SHARE --account-name $SA --account-key "$KEY" --quota 5

az containerapp env storage set --name provisioner-env -g $RG \
  --storage-name auditshare --azure-file-account-name $SA \
  --azure-file-account-key "$KEY" --azure-file-share-name $SHARE --access-mode ReadWrite
# app.yaml: agregar volume {name: audit, storageType: AzureFile, storageName: auditshare}
# + volumeMount {volumeName: audit, mountPath: /audit}
# + env AUDIT_LOG_FILE=/audit/audit.jsonl, AUDIT_SOURCE=provisioner

# el reaper en AKS monta el MISMO share via PV/PVC estático (ver ../k8s/reaper.yaml);
# su account key vive en un Secret de k8s en provisioner-system:
kubectl -n provisioner-system create secret generic provisioner-audit-azurefile \
  --from-literal=azurestorageaccountname=$SA \
  --from-literal=azurestorageaccountkey="$KEY"

# 8. Dominio custom via Cloudflare (enmascara el FQDN *.azurecontainerapps.io)
ASUID=$(az containerapp show -n provisioner -g $RG \
  --query properties.customDomainVerificationId -o tsv)
ACA_FQDN=$(az containerapp show -n provisioner -g $RG \
  --query properties.configuration.ingress.fqdn -o tsv)
# Cloudflare (zona gcamargo.xyz), crear primero en DNS-only para que valide el managed cert:
#   TXT   asuid.provisioner -> $ASUID     (proxied=false)
#   CNAME provisioner       -> $ACA_FQDN  (proxied=false)
az containerapp hostname add  -n provisioner -g $RG --hostname provisioner.gcamargo.xyz
az containerapp hostname bind -n provisioner -g $RG --hostname provisioner.gcamargo.xyz \
  --environment provisioner-env --validation-method CNAME
# una vez que el managed cert está en Succeeded, pasar el CNAME a proxied=true (SSL mode Full)
```

## Teardown

```sh
az containerapp delete -n provisioner -g devsu-rg --yes
az containerapp env delete -n provisioner-env -g devsu-rg --yes
```
