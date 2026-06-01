#!/usr/bin/env bash
# Stage 2: install the cluster add-ons on AKS after `terraform apply`.
# Reads values from terraform outputs. Run once per cluster.
set -euo pipefail

cd "$(dirname "$0")/.."

pushd terraform >/dev/null
RG=$(terraform output -raw resource_group)
AKS=$(terraform output -raw aks_name)
INGRESS_IP=$(terraform output -raw ingress_public_ip)
CERTMANAGER_CLIENT_ID=$(terraform output -raw certmanager_identity_client_id)
popd >/dev/null

az aks get-credentials -g "$RG" -n "$AKS" --admin --overwrite-existing

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null
helm repo add jetstack https://charts.jetstack.io >/dev/null
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ >/dev/null
helm repo add kyverno https://kyverno.github.io/kyverno/ >/dev/null
helm repo update >/dev/null

# ingress-nginx bound to the static public IP created in Terraform
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  -n ingress-nginx --create-namespace \
  --set controller.service.loadBalancerIP="$INGRESS_IP" \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-load-balancer-resource-group"="$RG" \
  --set controller.service.externalTrafficPolicy=Local

# cert-manager using workload identity for the DNS-01 solver
helm upgrade --install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace \
  --set crds.enabled=true \
  --set "podLabels.azure\.workload\.identity/use=true" \
  --set "serviceAccount.labels.azure\.workload\.identity/use=true"
kubectl annotate serviceaccount cert-manager -n cert-manager \
  "azure.workload.identity/client-id=${CERTMANAGER_CLIENT_ID}" --overwrite

helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system
# config.imagePullSecrets wires the out-of-band `acr-pull` Secret (see
# k8s/policies/acr-pull-secret.md) as --imagePullSecrets on the controllers, so the
# image-verification path can pull signatures from the private ACR (the kubelet
# AcrPull identity is NOT used by that path). The Secret must exist in ns kyverno.
helm upgrade --install kyverno kyverno/kyverno -n kyverno --create-namespace --wait \
  --set "config.imagePullSecrets={acr-pull}"

kubectl apply -k k8s/policies

echo "Add-ons installed. Ingress IP: ${INGRESS_IP}"
