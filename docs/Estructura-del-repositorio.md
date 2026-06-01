# Estructura del repositorio

El repositorio ([gcamargot/devsu-challenge](https://github.com/gcamargot/devsu-challenge/tree/master)) junta todo lo del servicio en un solo lugar: la aplicacion, su empaquetado en contenedor, los manifiestos de Kubernetes, la infraestructura como codigo y los pipelines. Lo armamos como un monorepo a proposito, porque la app, sus manifiestos y su infra van muy de la mano y nos resultaba mas claro versionarlos juntos que repartirlos en repos separados. Esta pagina recorre el layout real explicando que vive en cada carpeta y, sobre todo, por que esta donde esta. La rama por defecto es `master` (un detalle que nos costo un rato en CI, ver mas abajo).

## La aplicacion: `app/`

El corazon del servicio vive en [app/](https://github.com/gcamargot/devsu-challenge/tree/master/app), una app Node con Express organizada por feature en vez de por capa tecnica. En lugar de tener carpetas `controllers/`, `models/` y `routes/` con un archivo por recurso desparramado en cada una, agrupamos todo lo de un recurso junto. Hoy hay un solo recurso de negocio (`users`), pero el patron escala bien si mañana aparece otro.

El arranque esta en [app/index.js](https://github.com/gcamargot/devsu-challenge/blob/master/app/index.js): monta `express.json()`, los routers de `users` y de health, inicializa la base con reintentos (que fue una de las mejoras importantes sobre el starter; antes un fallo de conexion en el arranque era un unhandled rejection que mataba el pod) y maneja `SIGTERM`/`SIGINT` cerrando el server y el pool de forma ordenada.

El recurso de usuarios vive en [app/users/](https://github.com/gcamargot/devsu-challenge/tree/master/app/users) repartido en tres archivos con responsabilidades claras: el [router.js](https://github.com/gcamargot/devsu-challenge/blob/master/app/users/router.js) define las rutas, el [controller.js](https://github.com/gcamargot/devsu-challenge/blob/master/app/users/controller.js) tiene la logica de listar, obtener y crear, y el [model.js](https://github.com/gcamargot/devsu-challenge/blob/master/app/users/model.js) define el modelo Sequelize con el `dni` unico.

Lo transversal a toda la app esta en [app/shared/](https://github.com/gcamargot/devsu-challenge/tree/master/app/shared). Ahi esta la pieza que mas miramos cuando algo de configuracion no anda, [shared/database/database.js](https://github.com/gcamargot/devsu-challenge/blob/master/app/shared/database/database.js), que elige el dialecto (sqlite o postgres) por variable de entorno con un default segun `NODE_ENV`. Esto es lo que nos deja correr la misma app contra sqlite en tests y local, y contra postgres en el cluster, sin cambiar codigo. La validacion de payloads vive separada en [shared/middleware/validateSchema.js](https://github.com/gcamargot/devsu-challenge/blob/master/app/shared/middleware/validateSchema.js) y los esquemas yup en [shared/schema/users.js](https://github.com/gcamargot/devsu-challenge/blob/master/app/shared/schema/users.js).

Los healthchecks tienen su propia carpeta, [app/health/](https://github.com/gcamargot/devsu-challenge/tree/master/app/health): `/health` (liveness) no consulta dependencias a proposito, y `/ready` (readiness) si hace `authenticate()` contra la base. Esa distincion es la que evita que una base intermitente reinicie pods en vez de sacarlos de rotacion.

Los tests conviven con el codigo ([app/index.test.js](https://github.com/gcamargot/devsu-challenge/blob/master/app/index.test.js), [app/health.test.js](https://github.com/gcamargot/devsu-challenge/blob/master/app/health.test.js)) y corren con Jest. El resto de [app/](https://github.com/gcamargot/devsu-challenge/tree/master/app) es tooling de la app: [package.json](https://github.com/gcamargot/devsu-challenge/blob/master/app/package.json) (donde dejamos `sqlite3` como devDependency para no arrastrarlo al runtime), la config de ESLint, Babel para Jest y un `.env.example` de referencia.

## El contenedor: `Dockerfile` y `docker-compose.yml`

El [Dockerfile](https://github.com/gcamargot/devsu-challenge/blob/master/Dockerfile) en la raiz es multi-stage sobre `node:22-alpine`. Tiene una etapa `deps` que instala solo dependencias de produccion y una `runtime` que copia el codigo y esos node_modules. Corre como el usuario `node` (uid 1000), usa `tini` como PID 1 para que el `SIGTERM` llegue bien a node y se cosechen zombies, y trae un `HEALTHCHECK` contra `/health`. Un detalle que importa para la seguridad: en runtime borramos el `package-lock.json` y `npm`/`npx`, porque no hacen falta para correr y sacarlos baja tamaño y CVEs (es parte de como llegamos a cero HIGH/CRITICAL fixables en el scan de Trivy). El [docker-compose.yml](https://github.com/gcamargot/devsu-challenge/blob/master/docker-compose.yml) levanta el stack local (app mas postgres) para probar contra una base real sin tocar Kubernetes.

## Kubernetes: `k8s/`

Todo lo de Kubernetes esta en [k8s/](https://github.com/gcamargot/devsu-challenge/tree/master/k8s) y usa Kustomize con base mas overlays. Elegimos Kustomize en vez de Helm porque para una sola app la sobrecarga de templating de Helm no se justificaba; con base y overlays mantenemos un set comun.

El [k8s/base/](https://github.com/gcamargot/devsu-challenge/tree/master/k8s/base) tiene los manifiestos comunes a todos los entornos: el [deployment.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/deployment.yaml) con 2 replicas, las tres probes (startup, liveness, readiness), el securityContext endurecido (runAsNonRoot, readOnlyRootFilesystem, sin privilege escalation, drop ALL, seccomp RuntimeDefault), requests/limits y topologySpread; el [service.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/service.yaml) ClusterIP; el [hpa.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/hpa.yaml) (HPA v2, 2 a 5 replicas, CPU 70% / mem 80%); el [pdb.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/pdb.yaml) con `minAvailable: 1`; el [ingress.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/ingress.yaml); la [networkpolicy.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/networkpolicy.yaml); el [configmap.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/configmap.yaml) con la config no sensible; el [serviceaccount.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/serviceaccount.yaml) sin token automontado (la app no habla con la API de Kubernetes, asi que no tiene sentido darle uno); el [namespace.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/namespace.yaml); y un [secret.example.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/secret.example.yaml) que es solo plantilla (el Secret real lo pone el overlay o lo trae Key Vault).

Los overlays en [k8s/overlays/](https://github.com/gcamargot/devsu-challenge/tree/master/k8s/overlays) son cuatro, cada uno para un escenario distinto:

- [local-kind/](https://github.com/gcamargot/devsu-challenge/tree/master/k8s/overlays/local-kind): el entorno local en kind, con postgres in-cluster y un issuer self-signed.
- [aks/](https://github.com/gcamargot/devsu-challenge/tree/master/k8s/overlays/aks): el overlay productivo completo, con imagen de ACR, el `SecretProviderClass` que lee la password desde Key Vault via CSI, y los patches de configmap/ingress/deployment.
- [aks-live/](https://github.com/gcamargot/devsu-challenge/tree/master/k8s/overlays/aks-live): el estado live actual, el que aplica el CD hoy.

Las policies viven aparte en [k8s/policies/](https://github.com/gcamargot/devsu-challenge/tree/master/k8s/policies) porque no son de la app sino de la plataforma: son las reglas de Kyverno que aplican a todo lo que se despliega en el cluster. Estan la [require-requests-limits.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/policies/require-requests-limits.yaml) (obliga requests/limits), la [restricted-securitycontext.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/policies/restricted-securitycontext.yaml) (non-root, readonly, sin privesc, drop ALL) y la [default-networkpolicy.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/policies/default-networkpolicy.yaml) (genera una default-deny por namespace). El detalle de como interactuan esta en [Seguridad y hardening](Seguridad-y-hardening.md).

## Infraestructura: `terraform/`

La infra de Azure esta como codigo en [terraform/](https://github.com/gcamargot/devsu-challenge/tree/master/terraform), partida en archivos por dominio para que cada uno se lea solo. El [main.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/main.tf) tiene el Resource Group, el ACR y el AKS (Azure CNI, OIDC, workload identity, addon CSI de Key Vault) con el rol AcrPull para la kubelet identity. El [keyvault.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/keyvault.tf) define el Key Vault y el secret `db-password`. El [postgres.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/postgres.tf) tiene el PostgreSQL Flexible Server administrado, gateado por `enable_managed_pg`: es el diseño productivo previsto, hoy apagado. El [network.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/network.tf) define la VNet propia con sus subnets y NSGs (mas el Postgres administrado VNet-integrated, privado), gateado por `enable_vnet` como diseño de red productivo. El [identity.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/identity.tf) tiene las identidades OIDC (la app registration de GitHub Actions y la workload identity de cert-manager).

Hay dos archivos mas que se sumaron despues y vale ubicar. El [monitoring.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/monitoring.tf) define la capa de observabilidad administrada (la instancia de Azure Managed Grafana, el workspace de Azure Monitor managed Prometheus y la asociacion con el AKS), gateado por `enable_monitoring`: en el trial lo aplicamos por `az` CLI para no atarlo al ciclo del apply, pero la IaC queda versionada para prenderlo donde corresponda. El [finops.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/finops.tf) tiene el budget del resource group con sus alertas; el etiquetado de costos (los tags `project`, `owner`, `department`, `cost_center`, `environment`, `managed_by` que llevan todos los recursos) se define en [variables.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/variables.tf) y se propaga desde ahi. El para que de cada cosa esta en [Observabilidad](Observabilidad.md) y [Costos y FinOps](Costos-y-FinOps.md).

> <font color="#9a6700">**Atencion:**</font> `monitoring.tf` queda detras del flag `enable_monitoring` justamente porque la observabilidad administrada cuesta plata (~70 USD/mes, mayormente la instancia de Managed Grafana). No lo dejes prendido por descuido en una cuenta de prueba.

Para el edge hay dos archivos que conviene leer juntos porque cuentan una transicion. El [frontdoor.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/frontdoor.tf) tiene la IP publica estatica del ingress y la pieza de Azure Front Door, que era el plan original pero quedo gateado porque FD no esta incluido en el trial. Lo dejamos en el repo por si en una cuenta sin esa restriccion se quiere volver a el. El [cloudflare.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/cloudflare.tf) es el borde que efectivamente usamos: los registros DNS proxied (A `devsu-prod` y wildcard) apuntando a `20.98.237.230` y las reglas de WAF/rate-limit. El [dns.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/dns.tf) tiene la zona de Azure DNS, remanente del diseño con Front Door.

El resto son los archivos de soporte de cualquier modulo de Terraform: [variables.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/variables.tf), [locals.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/locals.tf), [outputs.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/outputs.tf), [providers.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/providers.tf) y [versions.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/versions.tf), mas un [README.md](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/README.md) con el flujo de uso. El `terraform.tfvars` real esta gitignored; el de ejemplo es el versionado.

## Add-ons del cluster: `scripts/`

En [scripts/](https://github.com/gcamargot/devsu-challenge/tree/master/scripts) esta el [bootstrap-addons.sh](https://github.com/gcamargot/devsu-challenge/blob/master/scripts/bootstrap-addons.sh), que es la segunda etapa del aprovisionamiento. Terraform crea la infra, y este script (despues del apply) instala con Helm lo que vive dentro del cluster: ingress-nginx atado a la IP estatica, cert-manager, metrics-server y Kyverno, y aplica las policies de `k8s/policies`. Lo separamos del apply de Terraform a proposito, porque configurar el provider de Helm contra un cluster que todavia no existe en el mismo apply es fragil.

## CI/CD: `.github/workflows/`

Los pipelines estan en [.github/workflows/](https://github.com/gcamargot/devsu-challenge/tree/master/.github/workflows), uno por etapa. El [ci.yml](https://github.com/gcamargot/devsu-challenge/blob/master/.github/workflows/ci.yml) hace build, lint, tests con coverage, analisis estatico con SonarQube Cloud, build de la imagen, scan con Trivy y push a GHCR.  El [cd.yml](https://github.com/gcamargot/devsu-challenge/blob/master/.github/workflows/cd.yml) se loguea a Azure por OIDC (sin secretos en el repo), importa la imagen de GHCR a ACR con `az acr import` y aplica el overlay con `kubectl apply`. El detalle de cada etapa esta en [Pipeline CI/CD](Pipeline-CICD.md). La config de Sonar vive en la raiz, en [sonar-project.properties](https://github.com/gcamargot/devsu-challenge/blob/master/sonar-project.properties).

## El provisioner: `provisioner/`

El self-service de entornos efimeros tiene su propio subdirectorio, [provisioner/](https://github.com/gcamargot/devsu-challenge/tree/master/provisioner), porque es practicamente una segunda app: un front htmx mas un backend Express que se deploya aparte (en Azure Container Apps). El backend esta en [provisioner/src/](https://github.com/gcamargot/devsu-challenge/tree/master/provisioner/src), con el [server.js](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/src/server.js) (las rutas del form, listar, crear y borrar entornos), [manifests.js](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/src/manifests.js) (que renderiza el set completo de manifiestos de un entorno: namespace, secret, configmap, postgres, app, ingress y NetworkPolicies), [kube.js](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/src/kube.js) (wrapper de kubectl), [ttl.js](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/src/ttl.js) (parseo de la duracion a `expiresAt`), [reaper.js](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/src/reaper.js) (el reaper one-shot que corre el CronJob y borra los namespaces vencidos) y [bootstrap.js](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/src/bootstrap.js) (decodifica el kubeconfig en ACA). El front es un solo [public/index.html](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/public/index.html). Los manifiestos de despliegue del propio provisioner estan en [provisioner/k8s/](https://github.com/gcamargot/devsu-challenge/tree/master/provisioner/k8s) (el CronJob reaper con su RBAC y el Deployment de fallback para AKS), y el [Dockerfile](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/Dockerfile) trae kubectl y corre como uid 1000. El como usarlo esta en [Self-service provisioner](Self-service-provisioner.md).

## Observabilidad: `observability/`

La capa de observabilidad tiene su propia carpeta, [observability/](https://github.com/gcamargot/devsu-challenge/tree/master/observability), separada del resto porque combina IaC, configuracion del cluster y artefactos de Grafana que conviene tener juntos. Adentro hay un [README.md](https://github.com/gcamargot/devsu-challenge/blob/master/observability/README.md) que explica el diseño (Managed Grafana mas Prometheus administrado, todo off-cluster), la carpeta [dashboards/](https://github.com/gcamargot/devsu-challenge/tree/master/observability/dashboards) con el JSON del dashboard "Devsu - Ephemeral Environments & App" (pods ready/total, restarts, CPU y memoria por namespace, tanto para `devsu` como para los efimeros `env-*`), y el [ama-metrics-settings-configmap.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/observability/ama-metrics-settings-configmap.yaml), que es el keep-list de metricas del addon de AKS (acota que series se ingestan, para no pagar de mas en cardinalidad). El provisionamiento real de los servicios administrados vive en `terraform/monitoring.tf`; esta carpeta es lo que se aplica encima (config del scraping y el dashboard a importar). El detalle de uso esta en [Observabilidad](Observabilidad.md).

> <font color="#0969da">**Nota:**</font> el JSON del dashboard se versiona a proposito, asi que recrear la instancia de Grafana no implica rehacer el panel a mano: se reimporta del repo.

## Documentacion: ahora en la wiki

Antes habia una carpeta `docs/` en el repo con el informe tecnico y la evidencia capturada de cada despliegue, y la sacamos: esta wiki es la unica fuente de verdad operativa y de diseño, y mantener documentacion en dos lados solo lleva a que se desincronicen. La evidencia de cada deploy (local en kind, live en AKS, policies de Kyverno) se referencia ahora desde las paginas correspondientes, en las secciones de Evidencia. Hoy `docs/` volvio al repo pero con otro proposito: es la fuente de un sitio estatico generado con MkDocs (junto con `mkdocs.yml` y `requirements-docs.txt`) que publica esta misma wiki. No es una segunda fuente de verdad sino un espejo de esta, generado a partir de los mismos contenidos.

> <font color="#0969da">**Nota:**</font> si venis de una version vieja del repo y buscas `docs/report.md` o `docs/evidence/`, ya no estan; lo que hay en `docs/` ahora son los `.md` generados de esta wiki para el sitio MkDocs. Lo que necesites esta aca.

## La raiz

Lo que queda en la raiz es tooling de proyecto: el [Makefile](https://github.com/gcamargot/devsu-challenge/blob/master/Makefile) con los atajos del dia a dia (`test`, `lint`, `coverage`, `docker-build`, `compose-up`, `kind-deploy`, los `tf-*` y `bootstrap`), el [.pre-commit-config.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/.pre-commit-config.yaml), el [.editorconfig](https://github.com/gcamargot/devsu-challenge/blob/master/.editorconfig), el [.dockerignore](https://github.com/gcamargot/devsu-challenge/blob/master/.dockerignore) y el [README.md](https://github.com/gcamargot/devsu-challenge/blob/master/README.md) como punto de entrada al repo.

## Evidencia

Las carpetas y archivos de primer nivel versionados, que coinciden con el layout descrito arriba:

```text
$ git ls-files | sed 's#/.*##' | sort -u
app
docker-compose.yml
Dockerfile
.dockerignore
docs
.editorconfig
.github
.gitignore
k8s
Makefile
mkdocs.yml
observability
.pre-commit-config.yaml
provisioner
README.md
requirements-docs.txt
scripts
sonar-project.properties
terraform
```
