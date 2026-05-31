# Operación

Esta página es el runbook con el que operamos Users API en el día a día: cómo lo desplegamos desde cero, cómo miramos su estado y sus logs, cómo damos marcha atrás cuando un deploy sale mal, qué revisamos ante los problemas que más se repiten, y cómo apagamos todo para no quemar el crédito de la cuenta de prueba. Todo lo que sigue asume que tenemos la CLI de `az` autenticada y un `kubectl` apuntando al clúster correcto, así que ese es el primer paso.

## Acceso al clúster

Lo primero que hacemos al sentarnos a operar es traernos las credenciales del clúster productivo y confirmar contra qué estamos hablando.
```bash
# Credenciales del clúster productivo
az aks get-credentials --resource-group devsu-rg --name devsu-aks --admin --overwrite-existing
kubectl config current-context
kubectl get nodes        # 2x Standard_D2s_v3, deberian estar Ready
```

## Despliegue

El despliegue tiene dos etapas bien separadas, y mantenerlas separadas fue una decisión consciente. La primera es la infraestructura con Terraform; la segunda son los add-ons del clúster con Helm. La razón es simple: cablear el provider de Helm de Terraform contra un clúster que todavía no existe dentro del mismo `apply` es frágil y se rompe de formas raras, así que preferimos que Terraform deje el clúster parado y que un script aparte instale lo que vive adentro.

### Etapa 1: infraestructura con Terraform (una sola vez)

```bash
cd terraform
az login
cp terraform.tfvars.example terraform.tfvars   # ajustar domain_name, location=eastus2, node_count=2...
terraform init
terraform plan -out tfplan
terraform apply tfplan
terraform output
```

Acá conviene recordar por qué la región es `eastus2` y no `eastus`, que fue nuestra primera elección. El detalle de los flags y la infra está en [terraform/](https://github.com/gcamargot/devsu-challenge/tree/master/terraform) y en su [README](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/README.md).

### Etapa 2: add-ons del clúster con Helm

Una vez que Terraform terminó y `terraform output` nos muestra el resource group, el nombre del AKS y la IP pública, corremos el bootstrap. El script n lee esos mismos outputs de Terraform y con ellos instala ingress-nginx (atado a la IP pública estática), cert-manager (con workload identity para el solver DNS-01), metrics-server y Kyverno, y al final aplica las políticas.

```bash
./scripts/bootstrap-addons.sh
# equivalente: make bootstrap
```

El script vive en [scripts/bootstrap-addons.sh](https://github.com/gcamargot/devsu-challenge/blob/master/scripts/bootstrap-addons.sh) y termina aplicando [k8s/policies](https://github.com/gcamargot/devsu-challenge/tree/master/k8s/policies), así que no hace falta correr ese `kubectl apply -k k8s/policies` por separado (es idempotente igual si queremos forzarlo). La IP pública que imprime al final es la `20.98.237.230` que el ingress expone hacia Cloudflare.

### Despliegue de la aplicación (vía CD)

Con la infra y los add-ons en su lugar, la app se despliega por el pipeline de CD, que es el camino normal.
- Por release: `git tag vX.Y.Z && git push --tags`.
- Manual: *Run workflow* sobre el job de CD, opcionalmente pasando un `image_tag`.

El CD hace login a Azure por OIDC, importa la imagen de GHCR a ACR con `az acr import`, resuelve los placeholders del overlay `aks` y aplica con `kubectl apply -k` seguido de `kubectl rollout status`. El detalle del pipeline está en [Pipeline-CICD](Pipeline-CICD.md).

### Aplicación manual de un overlay (operador)

Esto es para cuando el CD no está disponible y necesitamos mover algo a mano. Los overlays viven en [k8s/overlays](https://github.com/gcamargot/devsu-challenge/tree/master/k8s/overlays) y todos comparten la [base](https://github.com/gcamargot/devsu-challenge/tree/master/k8s/base) con Kustomize.

```bash
# Productivo (placeholders ya resueltos por el CD; manual solo para emergencias)
kubectl apply -k k8s/overlays/aks
kubectl -n devsu rollout status deploy/devsu-demo --timeout=180s

# Estado live actual sin dominio delegado: overlay aks-live
kubectl apply -k k8s/overlays/aks-live

# Local (kind): build + load + apply en un solo target del Makefile
make kind-deploy
```

  Verificar que `namespace: devsu` en el overlay (ver [k8s/overlays/local-kind/kustomization.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/overlays/local-kind/kustomization.yaml)). Para entornos creados a traves del provisioner el namespace se fija en el form.

## Estado y observabilidad

Para ver cómo está parado el servicio arrancamos siempre por una vista general del namespace y vamos bajando el nivel de detalle según lo que encontremos.

```bash
# Vista general del namespace
kubectl get all -n devsu

# Pods con distribucion por nodo (topologySpreadConstraints)
kubectl get pods -n devsu -o wide

# Logs en vivo
kubectl logs -n devsu deploy/devsu-demo -f
kubectl logs -n devsu deploy/devsu-demo --previous   # logs del contenedor anterior tras un restart

# Eventos recientes (utiles ante CrashLoop o rechazos de admission)
kubectl get events -n devsu --sort-by=.lastTimestamp
```

Con el `-o wide` esperamos ver las réplicas repartidas entre los dos nodos, y si las dos cayeron en el mismo nodo es una señal de que algo (capacidad, taints) está forzando esa distribución.

Para comprobar la salud real del proceso usamos los dos endpoints que le agregamos a la app: `/health` es la liveness (responde si el proceso vive) y `/ready` es la readiness (responde bien solo si la base contesta). La forma más directa de chequearlos sin pasar por el borde es un port-forward al Service.

```bash
kubectl -n devsu port-forward svc/devsu-demo 8080:80 &
curl -s localhost:8080/ready    # ok si la DB responde
curl -s localhost:8080/health   # ok si el proceso vive
```

Que `/ready` dependa de la base es por si la DB se cae, queremos que el pod salga del balanceo en vez de seguir recibiendo tráfico que va a fallar.

### Métricas e historia: el dashboard de Grafana

Lo de arriba es la foto puntual desde `kubectl`. Para la historia (CPU y memoria en el tiempo, restarts, readiness por entorno) la capa de observabilidad vive fuera del clúster, en Azure Managed Grafana con Azure Monitor managed Prometheus por detrás. El detalle de por qué quedó off-cluster está en [Observabilidad](Observabilidad.md); acá va el acceso operativo.

- URL del dashboard: https://devsu-grafana-hng2d6cze7fhh6ae.eus2.grafana.azure.com
- Login: no hay password propia de Grafana; se entra por Entra SSO con la cuenta de Azure. El operador tiene el rol **Grafana Admin** sobre la instancia (ver y editar).
- Qué mirar: el dashboard **"Devsu - Ephemeral Environments & App"**, con la variable `$namespace` que matchea los entornos efímeros `env-*` y el `devsu` productivo. Muestra pods ready/total, restarts, CPU y memoria por namespace, así que sirve para ver de un vistazo el estado de cada instancia del provisioner.

```bash
# Sumar a alguien como viewer (RBAC de Azure, no usuarios internos de Grafana)
az role assignment create --assignee <upn-o-objectId> --role "Grafana Viewer" \
  --scope $(az grafana show -n devsu-grafana -g devsu-rg --query id -o tsv)
```

> <font color="#0969da">**Nota:**</font> el addon de métricas de AKS (`ama-metrics`) es lo único de esta capa que corre dentro del clúster, y es liviano. Si en Grafana faltan datos, ahí es donde mirar primero: `kubectl get pods -n kube-system -l rsName=ama-metrics`. El JSON del dashboard y el keep-list de métricas están versionados en [observability/](https://github.com/gcamargot/devsu-challenge/tree/master/observability).

### Ingress, TLS y NetworkPolicy

```bash
kubectl get ingress -n devsu                      # host + ADDRESS (IP estatica 20.98.237.230)
kubectl get secret devsu-demo-tls -n devsu        # cert del origin (Cloudflare Origin CA como TLS secret)
kubectl get networkpolicy -n devsu                # default-deny-ingress + devsu-demo + devsu-postgres

# Solo si el origin usa Let's Encrypt (alternativa al Origin CA):
kubectl get certificate -n devsu
kubectl describe certificate devsu-demo-tls -n devsu   # diagnostico de emision (DNS-01 contra la API de Cloudflare)
```

Vale aclarar qué se ve y qué no desde `kubectl`. El certificado del tramo cliente-Cloudflare (Universal SSL) lo gestiona Cloudflare y no aparece acá; se inspecciona en su dashboard. Lo que vive en el clúster es solo el cert del origin (el tramo Cloudflare-ingress).
### Edge: Cloudflare

El edge (CDN, WAF, DDoS, Universal SSL) vive en Cloudflare plan free, fuera del clúster, y protege `devsu-prod.gcamargo.xyz` y los subdominios efímeros vía el wildcard `*.gcamargo.xyz`. Checklist a revisar cuando algo del edge no anda:

- DNS y registros: la zona `gcamargo.xyz` es autoridad en Cloudflare (los NS de GoDaddy se reapuntaron). Los registros (`devsu-prod` y el wildcard `*`) tienen que estar en modo proxied (la nube naranja); si quedan en "DNS only" (nube gris) se expone la IP del origin y se pierden WAF, DDoS y SSL de edge.
- TLS: edge con Universal SSL, modo SSL de la zona en Full (lo vamos a endurecer a Full strict con un cert Cloudflare Origin CA en el ingress).
- WAF y rate-limit: managed ruleset free más nuestra regla custom de rate-limit (en el plan free, periodo de 10s contra `ip.src` y `cf.colo.id`), security level en medium. Se ajustan en el dashboard o por Terraform.
- Hardening pendiente: restringir el ingress a los rangos de IP de Cloudflare para que nadie saltee el borde pegándole directo a la IP. Si Cloudflare actualiza sus rangos hay que refrescar esa allowlist (síntoma típico: 522 desde Cloudflare).
- IaC: estos recursos se gestionan con el provider `cloudflare` en [terraform/cloudflare.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/cloudflare.tf) usando un API token acotado a la zona.

```bash
# Comprobar que el borde esta delante (esperamos 'server: cloudflare' y 'cf-ray')
curl -sI https://devsu-prod.gcamargo.xyz/health | grep -i -E 'server|cf-ray'

# A que resuelve el host (deberia ser una IP anycast de Cloudflare, no 20.98.237.230)
dig +short devsu-prod.gcamargo.xyz
```

### Audit log del provisioner

Toda acción de create y destroy de entornos efímeros (incluidos los borrados automáticos por TTL que hace el reaper) queda registrada. Para auditarlo:

- Desde la web: https://provisioner.gcamargo.xyz/audit (las entradas más recientes, las mismas que muestra el panel de la UI). Para la versión cruda, `?format=json`.
- En el almacenamiento: el log es JSONL persistente en un share de Azure Files, montado tanto por el front en ACA como por el reaper en AKS, así que los creates manuales y los borrados por TTL caen en el mismo archivo. Es el lugar a mirar cuando se quiere el histórico completo y no solo las últimas entradas.

Cada línea anota quién (el usuario de Basic Auth), qué (group, app, release, subdomain, namespace), la acción y el resultado, con timestamp. El uso del provisioner y la lectura de su tabla de estado están en [Self-service-provisioner](Self-service-provisioner.md).

### Políticas (Kyverno)

```bash
kubectl get clusterpolicy
# add-default-networkpolicy / require-requests-limits / restricted-securitycontext -> READY True
```

Kyverno está en modo enforce, así que estas políticas no son sugerencias: si un pod nuevo no declara requests/limits o no cumple el securityContext endurecido (non-root, readonly rootfs, sin privilege escalation, drop ALL), la admission lo rechaza. El postgres in-cluster está excluido de la policy de securityContext porque necesita un rootfs escribible, pero sigue obligado a declarar requests/limits.

## HPA (autoscaling)

```bash
kubectl get hpa -n devsu
# devsu-demo  Deployment/devsu-demo  cpu: X%/70%, memory: Y%/80%  MIN 2  MAX 5

kubectl describe hpa devsu-demo -n devsu     # eventos de escalado y metricas actuales
kubectl top pods -n devsu                    # requiere metrics-server
```

El HPA escala entre 2 y 5 réplicas mirando CPU al 70% y memoria al 80%. Dos cosas para tener presentes: si `TARGETS` muestra `<unknown>`, lo primero que miramos es metrics-server (`kubectl get deploy -n kube-system metrics-server`), porque sin él el HPA no tiene métricas; y el PDB con `minAvailable: 1` es lo que protege la disponibilidad durante drains y upgrades, así que no lo tocamos a la ligera.

## Rollback

El rollback es a nivel de Deployment. Como el RollingUpdate está configurado con `maxUnavailable: 0`, dar marcha atrás no corta tráfico, y como la app hace shutdown ordenado en SIGTERM (cierra el HTTP server y el pool de la base antes de morir), ni los rollouts ni los rollbacks descartan requests en vuelo.

```bash
# Ver el historial de rollouts
kubectl rollout history deploy/devsu-demo -n devsu

# Volver a la revision anterior
kubectl rollout undo deploy/devsu-demo -n devsu

# Volver a una revision concreta
kubectl rollout undo deploy/devsu-demo -n devsu --to-revision=<N>

# Confirmar
kubectl rollout status deploy/devsu-demo -n devsu --timeout=180s
```

Cuando lo que queremos es volver a una imagen específica (los tags son inmutables, del estilo `sha-<git>`), el camino limpio es relanzar el CD con ese `image_tag`, que deja todo trazado. En emergencia, el atajo es setear la imagen a mano:

```bash
kubectl set image deploy/devsu-demo -n devsu \
  app=devsuacrgl5fdy.azurecr.io/devsu-challenge:sha-<git>
```

## Diagnóstico de problemas comunes

Estos son los síntomas con los que efectivamente nos cruzamos y dónde mirar en cada caso. La mayoría tiene una causa raíz que ya conocemos de haberla sufrido.

| Síntoma                                            | Dónde miramos                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pods en `Pending`                                  | Capacidad del clúster: `kubectl describe pod` suele decir `Insufficient cpu`. Pasa si quedó un solo nodo Ready (ingress-nginx + cert-manager + Kyverno ya consumen bastante). Verificar `kubectl get nodes` y que haya 2 nodos                                               |
| Pods en `CreateContainerConfigError`               | Casi siempre un Secret que no está en el namespace del pod. Es el bug que tuvimos en kind por no fijar `namespace` en el overlay: el Secret cayó en `default` y el pod en `devsu`. Revisar `kubectl get secret -n devsu` y el `namespace` del kustomization                  |
| Pods en `CrashLoopBackOff` al arrancar             | Logs con `--previous`; chequear si la DB responde (`/ready`) y si está la NetworkPolicy `devsu-postgres` que habilita app->pg:5432                                                                                                                                           |
| `/ready` devuelve 503                              | Conectividad a la base: `DB_HOST`, credenciales, y en AKS la NetworkPolicy app->pg:5432                                                                                                                                                                                      |
| Pod nuevo rechazado al aplicar                     | Admission de Kyverno: faltan requests/limits o no cumple el securityContext hardened. La causa concreta sale en `kubectl get events -n devsu`                                                                                                                                |
| 5xx desde Cloudflare (502/504/521/522)             | El origin no responde o la allowlist de IPs de Cloudflare lo está bloqueando. El 522 típico es timeout contra el origin: revisar estado del ingress y del Service, el cert del origin (Origin CA) y, si se endureció el hardening, que los rangos de Cloudflare sigan al día |
| Certificate `READY=False` (solo con Let's Encrypt) | `kubectl describe certificate`; token de la API de Cloudflare y zona DNS; usar el issuer staging para depurar. Con Origin CA no hay objeto Certificate, se verifica el TLS secret directamente                                                                               |
| HPA `TARGETS <unknown>`                            | metrics-server caído o sin instalar (`kubectl get deploy -n kube-system metrics-server`)                                                                                                                                                                                     |

## Costos y limpieza

La infra en la cuenta de prueba nos sale del orden de 5 a 8 dólares por día: el control plane de AKS es Free (0 dólares), y lo que pesa son los nodos `D2s_v3`, el Load Balancer Standard y el ACR Basic (el PostgreSQL administrado solo sumaría si prendiéramos `enable_managed_pg`). El edge corre en Cloudflare plan free, así que no agrega costo en Azure. A eso se le suma la capa de observabilidad, que es la pieza más cara: Azure Managed Grafana Standard ronda los 65 dólares/mes flat (más el ingest de Prometheus, total ~70). Con todo eso entramos dentro del crédito de 200 dólares en 30 días, pero el margen no es infinito, por lo que la regla que seguimos es destruir el entorno apenas capturamos la evidencia o se cierra la ventana de uso. El desglose por componente y la estrategia de tags y budget están en [Costos y FinOps](Costos-y-FinOps.md).

```bash
# Tear down completo de la infraestructura de Azure
cd terraform
terraform destroy        # equivalente: make tf-destroy
```

> <font color="#cf222e">**Importante:**</font> `terraform destroy` no alcanza para limpiar todo. Lo que en el trial se creó por `az` CLI (y no por `terraform apply`) queda por fuera del state y hay que borrarlo aparte: la observabilidad (Azure Managed Grafana `devsu-grafana`, el Azure Monitor workspace `devsu-amw`, y el addon de métricas del AKS), el storage del audit log del provisioner (el share de Azure Files) y los recursos del provisioner en Azure Container Apps. Por costo, el primero a apagar es siempre el **Grafana**, que es el de mayor cargo flat.

```bash
# 1) Grafana primero (es el de mayor costo flat, ~65 USD/mes)
az grafana delete -n devsu-grafana -g devsu-rg --yes

# 2) Addon de métricas de AKS + Azure Monitor workspace
az aks update -g devsu-rg -n devsu-aks --disable-azure-monitor-metrics
az resource delete --ids $(az monitor account show -n devsu-amw -g devsu-rg --query id -o tsv)
# el resource group administrado MA_devsu-amw_eastus2_managed se va con el workspace

# 3) Provisioner en ACA + el storage del audit log (Azure Files)
az containerapp delete -n provisioner -g devsu-rg --yes
az containerapp env delete -n provisioner-env -g devsu-rg --yes
# borrar el file share / storage account del audit log JSONL que usan ACA y el reaper
```

Como atajo, borrar el resource group entero (`az group delete -n devsu-rg --yes`) se lleva todo de una (incluido el RG administrado del workspace), pero conviene tener presente qué piezas son las que `terraform destroy` no toca, sobre todo el Grafana, para no dejarlo prendido por olvido.

Un par de cosas más a tener en cuenta al limpiar. AKS y el LB Standard cobran por hora. Los entornos efímeros que levanta el provisioner self-service se auto-destruyen por TTL gracias al CronJob reaper, pero igual los auditamos de vez en cuando con `kubectl get ns -l provisioner.devsu.io/managed=true` (ver [Self-service-provisioner](Self-service-provisioner.md)). Y el registro del dominio (App Service Domains, del orden de 12 dólares al año) normalmente no lo cubre el crédito del trial, así que ese gasto va por afuera.

Los targets del [Makefile](https://github.com/gcamargot/devsu-challenge/blob/master/Makefile) (`make tf-apply`, `make bootstrap`, `make tf-destroy`, `make kind-deploy`) envuelven todo lo de arriba para no tener que recordar las rutas a mano.

## Mejoras propuestas para producción

Hay un puñado de cosas que dejamos documentadas como el salto natural a un entorno productivo de verdad, una vez fuera de las restricciones del trial:

- PostgreSQL administrado (`enable_managed_pg=true`) con private endpoint sobre VNet, en lugar del postgres in-cluster.
- Backend de estado remoto de Terraform (`azurerm` con storage account) para poder trabajar en equipo sin pisarnos el state.
- Cloudflare de pago (Pro o Business) para WAF avanzado: rulesets OWASP completos, bot management y reglas de rate-limit más finas.
- Alertas y logs centralizados sobre la observabilidad que ya tenemos: hoy la capa de métricas (Azure Managed Grafana + Azure Monitor managed Prometheus) está desplegada y documentada en [Observabilidad](Observabilidad.md); el salto productivo es sumar reglas de alerta de Prometheus y centralizar logs (Azure Monitor Logs / Container Insights).

## Evidencia

> Espacio para pegar la evidencia de que el clúster y la infra responden como se describe (reemplazar por salida real o captura):
>
> - `kubectl get nodes -o wide` (esperamos 2x Standard_D2s_v3 en estado Ready)
> - `kubectl get pods -n devsu -o wide` (réplicas repartidas entre nodos)
> - `kubectl get hpa -n devsu`
> - `terraform output` (corrido en `terraform/`)
> - `az aks show -g devsu-rg -n devsu-aks -o table`
>
> ```text
> (pegar aca la salida / captura)
> ```
