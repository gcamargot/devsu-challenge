# Users API

API REST de gestión de usuarios sobre `/api/users` (campos `dni` y `name`). Node + Express con persistencia en PostgreSQL. Corre en AKS detrás de Cloudflare, con CI/CD por GitHub Actions e infraestructura como código en Terraform.

## Quickstart

```bash
make test            # tests con cobertura
make docker-build    # construye la imagen
make kind-deploy     # build + load + deploy en kind local
make tf-plan         # plan de Terraform
make tf-apply        # aplica la infra en Azure
make bootstrap       # instala los add-ons del cluster (etapa 2)
```

## Estructura

El repo agrupa la app (`app/`), el empaquetado en contenedor, los manifiestos de Kubernetes (`k8s/`) y la infraestructura (`terraform/`). El detalle de cada carpeta está en [Estructura del repositorio](https://gcamargot.github.io/devsu-challenge/Estructura-del-repositorio/).

## Documentación completa

La documentación técnica vive en la [wiki del proyecto](https://gcamargot.github.io/devsu-challenge/). Puntos de entrada útiles:

- [Arquitectura cloud](https://gcamargot.github.io/devsu-challenge/Arquitectura-cloud/)
- [Pipeline CI/CD](https://gcamargot.github.io/devsu-challenge/Pipeline-CICD/)
- [Operación](https://gcamargot.github.io/devsu-challenge/Operacion/)
