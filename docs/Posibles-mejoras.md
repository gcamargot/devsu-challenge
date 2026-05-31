# Posibles mejoras

Esta pagina es el roadmap de lo que todavia no aplicamos. El resto de la wiki documenta el sistema tal como esta hoy y lo que ya endurecimos; aca juntamos las mejoras de mayor valor que quedaron pendientes, ordenadas en dos grupos: seguridad y FinOps. La idea es dejarlas escritas con honestidad, separando lo que es trabajo desde cero de lo que ya existe a medias en la IaC y solo espera el visto bueno para pasar a produccion. No hay nada aca que sea bloqueante para operar el servicio; son pasos que suben el piso de seguridad y bajan el costo, y que conviene tener anotados para el que venga despues.

> <font color="#0969da">**Nota:**</font> varias de estas mejoras ya estan parcialmente escritas como IaC y van detras de un flag apagado (la VNet propia con PostgreSQL privado), o ya existen en una version inicial que solo falta promover (la firma de imagenes esta en CI y la policy de verificacion corre en modo Audit). Cuando es el caso lo decimos explicitamente, asi se distingue lo que es empezar de cero de lo que es apretar un interruptor.

## Seguridad

### Acotar el RBAC del provisioner

Es la mejora de seguridad de mayor impacto de toda la lista. Hoy el provisioner self-service, en su despliegue en vivo sobre Azure Container Apps, monta el kubeconfig admin de AKS como secret de ACA (base64, montado como volumen y decodificado en el arranque por [bootstrap.js](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/src/bootstrap.js)). Eso significa que una credencial de administrador del cluster vive fuera del cluster, y que si ese secret se filtra el atacante tiene control total del AKS, no solo de los entornos efimeros. El reemplazo es darle al provisioner una ServiceAccount (o una identidad federada) con permisos minimos: solo crear y borrar los namespaces de los entornos efimeros y aplicar la app adentro, nada de cluster-admin.

La buena noticia es que ese diseño ya existe en el repo para la variante in-cluster. El manifiesto [provisioner/k8s/provisioner-aks.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/k8s/provisioner-aks.yaml) corre la misma imagen dentro del cluster con una ServiceAccount y un ClusterRole acotado a namespaces, pods, services, configmaps, secrets, deployments, ingresses y networkpolicies (los grupos que el backend necesita para levantar un entorno completo), sin tocar nada por fuera de eso. El paso pendiente es que el despliegue en vivo deje de usar el kubeconfig admin sobre ACA y pase a ese modelo de identidad acotada, de modo que ninguna credencial de administrador de larga vida salga del cluster.

> <font color="#9a6700">**Atencion:**</font> mientras el provisioner en vivo siga con el kubeconfig admin montado en ACA, el blast radius de ese unico secret es el cluster entero. Es la razon por la que esta mejora encabeza la lista: el resto endurece capas, esta cierra el peor caso.

### Cloudflare Access (Zero Trust) delante del provisioner

El panel del provisioner hoy se protege con Basic Auth (un usuario `devsu-admin` con password compartida, leida de los secrets de ACA, no horneada en la imagen; ver [src/auth.js](https://github.com/gcamargot/devsu-challenge/blob/master/provisioner/src/auth.js)). Funciona, pero una password compartida no tiene identidad por persona, no tiene MFA y rota mal. La mejora es poner Cloudflare Access (Zero Trust) por delante del origen en `provisioner.gcamargo.xyz`: la autenticacion pasa a ser SSO contra un proveedor de identidad con MFA, y el provisioner deja de depender de una password compartida. Como el panel ya esta detras de Cloudflare, encajar Access no cambia la topologia, solo agrega la capa de identidad en el borde antes de llegar al backend.

### API server de AKS privado o authorized IP ranges

El control plane de AKS hoy expone su endpoint publico. Aun con todo lo demas endurecido, eso deja la API de Kubernetes alcanzable desde internet (protegida por autenticacion, pero alcanzable). Las dos formas de cerrarlo son un private cluster (el API server resuelve solo por una zona de DNS privada dentro de la VNet) o, mas liviano, configurar authorized IP ranges para que el endpoint solo acepte conexiones desde un conjunto acotado de IPs (las del CI/CD y las de operaciones). La primera es la postura mas fuerte y se complementa con la VNet propia que describimos abajo; la segunda no requiere recrear el cluster y ya sube bastante el piso.

### VNet propia con PostgreSQL privado

Esta mejora ya esta escrita como IaC y solo espera prenderse. En el deploy actual AKS corre sobre la VNet que el propio servicio crea y administra (una sola subnet, sin segmentacion pensada) y la base, al estar el PostgreSQL administrado apagado por la restriccion del trial, corre in-cluster. El diseño productivo define una VNet propia con segmentacion por subnets y NSGs, escrito en [terraform/network.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/network.tf) detras del flag `enable_vnet`: una subnet para los nodos y pods de AKS (`snet-aks`) y otra para los datos (`snet-data`), esta ultima delegada a PostgreSQL Flexible para integrarlo a la VNet sin endpoint publico, con un NSG que solo admite el puerto 5432 desde la subnet de AKS y una zona de DNS privada para resolver la base.

El valor es doble: saca la base de internet (reemplaza el parche de acceso publico mas firewall que se usa en el trial) y segmenta el trafico a nivel de subnet, no solo de pod. Para activarlo alcanza con prender `enable_vnet` (y `enable_managed_pg` para la base administrada privada). El motivo por el que quedo apagado es practico: meter AKS en una VNet propia obliga a recrear el cluster, y la base administrada que mas se beneficia esta restringida en la suscripcion de prueba. En una cuenta sin esas restricciones se aplica de entrada en un deploy desde cero.

### NetworkPolicy de egress

Hoy la postura de red interna es ingress-only: Kyverno genera una `default-deny-ingress` por namespace y sobre eso abrimos lo minimo de entrada (el ingress puede llegar a la app, la app puede llegar a postgres; ver [k8s/policies/default-networkpolicy.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/policies/default-networkpolicy.yaml) y [k8s/base/networkpolicy.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/base/networkpolicy.yaml)). Lo que falta es la cara de salida: acotar el egress de los pods de la app a lo estrictamente necesario (DNS, la base de datos y los endpoints de Azure que haga falta), en vez de dejar la salida abierta. Con eso, un pod comprometido no puede exfiltrar a un destino arbitrario ni usarse de pivote hacia internet, que es justo el movimiento que una default-deny de egress corta.

### Microsoft Defender for Containers

El servicio cubre lo que hoy no tenemos en runtime: deteccion de amenazas sobre el cluster en vivo (comportamiento anomalo de pods, conexiones sospechosas, tecnicas conocidas) y scan continuo de las imagenes en ACR mas alla del gate de Trivy que ya corre en CI. La cadena de imagen en build esta cubierta (ver [Seguridad y hardening](Seguridad-y-hardening.md)), pero una vez que la imagen esta corriendo no hay nada vigilando el runtime; Defender for Containers llena ese hueco con telemetria que ademas se integra con el resto de la observabilidad de Azure.

### Rotacion de secretos por Key Vault

Hoy Key Vault guarda el password de la base y lo entrega por el driver CSI en runtime (ver [terraform/keyvault.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/keyvault.tf)), que ya es la postura correcta de almacenamiento. El paso pendiente es la rotacion: que el password de la base y la credencial del provisioner se roten de forma gestionada por Key Vault (con su politica de rotacion y la recarga del secret en el cluster), en vez de ser valores fijos de larga vida. Un secreto que rota acota la ventana en la que una filtracion sirve de algo.

### Enforce de firma de imagenes

Esta mejora es de las que ya estan a un paso. En CI las imagenes se firman con cosign keyless (Fulcio emite un certificado efimero atado a la identidad OIDC del workflow y la firma queda en el log de transparencia Rekor; ver [.github/workflows/ci.yml](https://github.com/gcamargot/devsu-challenge/blob/master/.github/workflows/ci.yml)). Y del lado del cluster ya corre una policy Kyverno `verifyImages` que valida esa firma, en [k8s/policies/verify-images.yaml](https://github.com/gcamargot/devsu-challenge/blob/master/k8s/policies/verify-images.yaml), acotada solo a las imagenes de `devsu-challenge` (las publicas como postgres, ingress-nginx, cert-manager o kyverno nunca se matchean ni se bloquean). Esa policy esta hoy en modo Audit a proposito: la imagen que corre en el cluster todavia es una sin firmar, asi que pasarla a Enforce la bloquearia. El paso pendiente es el cutover: una vez que solo corran imagenes firmadas por el CI actualizado, pasar `validationFailureAction` de Audit a Enforce, con lo que el cluster pasa a rechazar cualquier imagen propia que no este firmada por nuestro pipeline.

> <font color="#1a7f37">**Tip:**</font> el orden importa. Primero se rueda una imagen firmada a produccion y se confirma en los reportes de Audit que matchea la firma esperada; recien ahi se flipea a Enforce. Hacerlo al reves deja la app sin poder arrancar.

### Service mesh con mTLS interno

El trafico este-oeste dentro del cluster (entre el ingress, la app y la base in-cluster) hoy va en claro a nivel de red; lo que lo acota es la NetworkPolicy, que decide quien habla con quien pero no cifra. Un service mesh liviano (Linkerd o Istio) agrega mTLS automatico entre pods, con lo que el trafico interno queda cifrado y ademas autenticado por identidad de workload, no solo por origen de red. Es la capa que falta para que, aun si alguien observa el trafico dentro del cluster, no lea nada en claro.

### WAF con managed rules de OWASP en Cloudflare

El borde hoy corre el WAF managed ruleset gratuito de Cloudflare mas una regla de rate-limit propia (ver [Seguridad y hardening](Seguridad-y-hardening.md)), que cubre la familia conocida de ataques de aplicacion en el plan free. El siguiente escalon es habilitar el managed ruleset de OWASP Core con su scoring, que da una cobertura mas fina y configurable contra la familia de ataques OWASP. Requiere el plan Pro de Cloudflare, asi que es una mejora con costo asociado, pero para un servicio publico sin auth es de las que mas rinden por dolar.

## FinOps

La estrategia de costos del sistema (tags en todos los recursos, budget con alertas, y la disciplina de apagar lo que no se usa) ya esta montada y documentada en [Costos y FinOps](Costos-y-FinOps.md). Lo que sigue son las mejoras que la llevan mas lejos: del control manual al enforcement automatico, y del compute always-on al compute elastico y mas barato.

### Azure Policy para forzar los tags de costeo

Hoy todos los recursos heredan el mismo mapa de tags (`project`, `owner`, `department`, `cost_center`, `environment`, `managed_by`) porque la IaC los pasa a cada recurso via `var.tags` (ver [terraform/variables.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/variables.tf) y la nota en [terraform/finops.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/finops.tf)). Eso depende de la disciplina de IaC: un recurso creado a mano por fuera de Terraform puede quedar sin imputacion. La mejora es una Azure Policy de tipo `require-tag` o `append` en el scope de la suscripcion o el management group, que fuerce (o herede) los tags de costeo en todo recurso nuevo, venga de donde venga. Asi ningun gasto puede aparecer sin a quien imputarlo, sin depender de que quien lo creo se acuerde.

### Cost Management: exportes y alertas de anomalia por tag

El budget actual sobre el resource group avisa al 80% (forecast) y al 100% (actual) del monto total. La mejora lleva eso a un esquema de chargeback: exportes programados de Cost Management a un storage, filtrados y agrupados por tag, mas alertas de anomalia que detecten desvios de gasto por `department` o `project`. Con eso cada area ve su consumo y se la puede cargar (chargeback por departamento o proyecto), en vez de mirar el gasto como una sola bolsa a nivel resource group. Los tags que lo hacen posible ya estan; falta la automatizacion del reporte y la alerta sobre ellos.

### Node pool spot para los entornos efimeros

Los entornos efimeros que levanta el provisioner son no-productivos y toleran de sobra que un nodo se recicle. Para esa carga, un node pool de tipo spot (capacidad sobrante de Azure a una fraccion del precio on-demand) baja el costo de manera notable. La idea es separar la carga: los entornos efimeros del provisioner van a un pool spot, y la app de produccion sigue en el pool estable. Como esos entornos ya son descartables por diseño (tienen TTL y un tope de concurrencia), la posibilidad de que Azure recupere un nodo spot encaja con su naturaleza.

### Cluster autoscaler con scale-to-zero para el pool no-prod

Sobre ese mismo pool no-prod, el cluster autoscaler con scale-to-zero apaga los nodos cuando no hay entornos efimeros corriendo y los vuelve a levantar cuando se pide uno. Fuera de horario (noches, fines de semana) el pool no-prod cae a cero nodos y deja de costar compute. El pool de produccion no se toca: la app sigue con sus replicas estables. Es la version automatica de la disciplina de apagar lo que no se usa, aplicada al compute de no-prod.

### Reservations o Savings Plans para los nodos estables de prod

Los nodos de produccion corren siempre, y para una carga predecible y always-on el precio on-demand es el mas caro de todos. Comprometer ese compute con una Reservation o un Savings Plan de Azure (uno o tres años) baja el costo por hora de manera significativa a cambio del compromiso. Aplica solo a los nodos estables de prod, no a lo elastico ni a lo spot, que justamente sacan su ahorro del lado contrario (no comprometerse). Es la pieza de FinOps que rinde sobre la base de compute que no se va a apagar.

### Apagar el Managed Grafana cuando no se usa

Es el item de mayor costo del despliegue: Azure Managed Grafana en plan Standard ronda los 65 USD/mes flat (mas el ingest de Prometheus, total cercano a 70 USD/mes), y a diferencia del resto cobra parejo aunque nadie lo mire. La mejora operativa es tratarlo como un recurso de demanda: apagarlo (o destruirlo) entre sesiones de uso y levantarlo cuando hace falta mirar dashboards, en vez de dejarlo prendido quemando el costo flat. El detalle de la capa de observabilidad y su costo esta en [Observabilidad](Observabilidad.md); el procedimiento de teardown esta en el runbook de [Operacion](Operacion.md).

> <font color="#1a7f37">**Tip:**</font> de toda la lista de FinOps, apagar el Grafana cuando no se usa es lo de mayor retorno inmediato y lo unico que no requiere infraestructura nueva: es puramente operativo y se hace hoy mismo.

## Como leer esta lista

Ninguna de estas mejoras es un parche de algo roto; el sistema opera bien como esta. Son el siguiente nivel de madurez, y conviene encararlas por valor: en seguridad, acotar el RBAC del provisioner es lo que cierra el peor caso y va primero; en FinOps, apagar el Grafana y separar el compute no-prod (spot mas scale-to-zero) es lo que mas rinde con menos esfuerzo. Lo que ya esta a medias en la IaC (la VNet propia con la base privada, la firma de imagenes con su verificacion en Audit) es lo mas barato de promover, porque el trabajo de diseño ya esta hecho y solo falta el interruptor.
