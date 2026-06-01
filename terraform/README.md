# Terraform — infraestructura en Azure

Provisiona la infraestructura de la Users API en Azure.

## Qué provisiona

- Resource Group
- **ACR** (registro de contenedores)
- **AKS** (cluster de Kubernetes)

Detrás de flags, opcionalmente:

- **VNet** dedicada
- **PostgreSQL Flexible Server** managed
- **Azure Front Door** como borde
- **Azure DNS** zone para el dominio

## Uso

```bash
make tf-plan
make tf-apply
```

O directamente con Terraform:

```bash
terraform init
terraform plan -out tfplan
terraform apply tfplan
```

Las variables van en `terraform.tfvars` (gitignored). Tomar `terraform.tfvars.example` como base.

## Variante del trial

El deploy del trial corre con esos flags apagados: PostgreSQL in-cluster (no el managed), Cloudflare como borde (no Front Door) y nodos `Standard_D2s_v3`. La variante managed con VNet, PostgreSQL Flexible Server y Front Door se habilita activando los flags correspondientes.

## Más detalle

- [Infra en Azure](https://gcamargot.github.io/devsu-challenge/Procedimiento-4-infra-azure/)
