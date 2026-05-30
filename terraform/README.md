# Terraform — infraestructura en Azure

Provisiona la infra del challenge en Azure:

- Resource Group, **ACR** (Basic)
- **AKS** (control plane Free, 1× `Standard_B2s`, Azure CNI con NetworkPolicy, OIDC + workload identity, addon CSI de Key Vault)
- **PostgreSQL Flexible Server** (B1ms) + base `devsu`
- **Azure DNS** zone para el dominio
- **Key Vault** + secret `db-password` (lo lee el CSI driver en runtime)
- Identidades: workload identity para **cert-manager** (DNS-01 sobre la zona) y app registration con **OIDC** para GitHub Actions
- IP pública estática para el ingress + **Azure Front Door** (Standard) con custom domain `app.<dominio>`, **WAF** (rate-limit) y origin = ingress de AKS (`origin.<dominio>`)

## Uso

```bash
az login                      # el provider azurerm usa la sesión de az CLI
cp terraform.tfvars.example terraform.tfvars   # setear domain_name
terraform init
terraform fmt -check
terraform validate
terraform plan -out tfplan
terraform apply tfplan
terraform output
```

## Flujo en dos etapas

Terraform crea la **infra**. Los **add-ons del cluster** (ingress-nginx apuntado a la IP
estática, cert-manager, metrics-server, Kyverno) se instalan después con Helm
(ver `../docs/` y el job de CD), porque configurar el provider helm contra un cluster
que todavía no existe en el mismo apply es frágil. El `ClusterIssuer` (DNS-01) se aplica
una vez que cert-manager está arriba.

## Dominio

El dominio se registra con **Azure App Service Domains** (no hay recurso de Terraform
estable para el registro). App Service Domains puede crear la zona DNS automáticamente;
acá la zona se administra como código. Si el registrar es externo, delegar los NS de
`terraform output dns_zone_name_servers`.

## Costo y limpieza

~$5–8/día (control plane Free $0; nodo B2s, LB Standard, ACR Basic, PG B1ms, Front Door
Standard, zona DNS). Dentro del crédito de $200/30 días. **Correr `terraform destroy`
apenas capturada la evidencia.**

> ⚠️ El registro del dominio (App Service Domains, ~$12/año) normalmente **no** lo cubre el
> crédito del trial y puede requerir pay-as-you-go.

## Producción (no incluido por costo/alcance)

- PostgreSQL con **private endpoint** / VNet en vez de acceso público + firewall.
- Backend de estado remoto (`azurerm` con storage account).
- WAF con **managed rule sets** (requiere Front Door **Premium**).
