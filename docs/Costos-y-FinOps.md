# Costos y FinOps

Esta página junta dos cosas que en la práctica van de la mano: cuánto cuesta el despliegue y cómo hacemos para imputar ese costo a quien corresponde. La motivación de fondo es que aunque hoy esto corre sobre una suscripción de prueba, la estrategia que usamos es la misma que aplicaríamos en producción, donde el costo se reparte entre proyectos y departamentos y alguien tiene que poder explicar cada dólar. Por eso etiquetamos todo y montamos un budget con alertas desde el principio, en vez de dejarlo para después.

## Tags en todos los recursos

La pieza central de la estrategia son los tags de Azure. Cada recurso que crea Terraform lleva el mismo conjunto de etiquetas, que es lo que después permite a Azure Cost Management cortar el gasto por la dimensión que uno quiera. Las etiquetas son:

| Tag | Valor en el trial | Para qué sirve |
|---|---|---|
| `project` | `devsu-challenge` | Agrupar el gasto del proyecto entero. |
| `owner` | `gcamargot` | Saber a quién pertenece el recurso. |
| `department` | `devops` | Imputar el costo al departamento. |
| `cost_center` | `cc-1001` | El centro de costos contable al que se carga. |
| `environment` | `production` | Separar prod de dev/qa/efímeros. |
| `managed_by` | `terraform` | Distinguir lo gestionado por IaC de lo creado a mano. |

La gracia es que con esas etiquetas Azure Cost Management puede hacer dos cosas que son justo lo que pide FinOps: en **Cost analysis** se agrupa o filtra el gasto por cualquiera de los tags (por ejemplo, todo lo de `department=devops`, o el costo de `project=devsu-challenge` cruzado por `environment`), y se pueden programar **exportes** periódicos a un storage filtrados por tag para alimentar un dashboard o un reporte contable. Sin los tags, el gasto llega como una bolsa indistinta por tipo de recurso y reconstruir a posteriori quién consumió qué es un dolor.

> <font color="#1a7f37">**Tip:**</font> la convención es que todo recurso nuevo herede el mismo mapa de tags. En Terraform se logra pasando `var.tags` a cada recurso, así que sumar un componente no requiere recordar las etiquetas a mano. Para forzarlo a nivel organización el paso siguiente sería una Azure Policy de `require-tag`/`append` en el scope de la suscripción o el management group; lo dejamos como recomendación porque en una sola suscripción de trial alcanza con la disciplina de IaC.

La definición de los tags está en [terraform/variables.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/variables.tf) (la variable `tags`, que se aplica a todos los recursos del despliegue).

## El budget con alertas

Etiquetar permite mirar el gasto hacia atrás; el budget es lo que avisa antes de que se vaya de las manos. Definimos un budget mensual sobre el resource group `devsu-rg` con dos alertas: una al 80% del monto sobre el gasto **proyectado** (forecast, para que avise temprano cuando la tendencia va a superar el tope) y otra al 100% sobre el gasto **real** (actual, cuando efectivamente se cruzó). El monto y los mails de aviso son parametrizables, y el budget solo se crea si hay al menos un mail de contacto cargado (un budget sin destinatario de la notificación no tiene sentido).

> <font color="#0969da">**Nota:**</font> el budget es preventivo, no un tope que corta el gasto. Azure no apaga recursos al llegar al límite; manda la alerta a los contactos configurados. La acción (apagar, destruir, escalar) sigue siendo manual, así que la alerta sirve para reaccionar a tiempo, no para confiarse.

La IaC del budget está en [terraform/finops.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/finops.tf), junto con la nota sobre cómo se haría el enforcement de tags por Azure Policy.

## Costo aproximado por componente

Este es el desglose aproximado del costo mensual del despliegue (orden de magnitud, región `eastus2`, en USD). Sirve para ver de dónde sale el gasto y, sobre todo, qué conviene apagar primero.

| Componente | Detalle | Costo aprox/mes (USD) |
|---|---|---|
| AKS control plane | SKU Free | 0 |
| Nodos AKS | 2x `Standard_D2s_v3` | el grueso del compute |
| Load Balancer | Standard, del ingress | bajo, pero cobra por hora |
| ACR | SKU Basic | bajo |
| Key Vault | operaciones + secrets | muy bajo |
| Azure Files | share del audit log del provisioner | muy bajo |
| Azure Container Apps | front del provisioner (Consumption) | bajo (escala a poco uso) |
| Azure Managed Grafana | plan Standard, flat | ~65 |
| Azure Monitor (Prometheus) | pay-per-ingest, perfil mínimo | ~1-5 |

> <font color="#9a6700">**Atencion:**</font> el costo diario del core de infra (nodos D2s_v3, LB Standard y ACR Basic) ronda los 5-8 USD/día, que dentro del crédito de 200 USD en 30 días deja un margen finito. Y la observabilidad agrega aparte la pieza más cara de todas: Azure Managed Grafana Standard son ~65 USD/mes flat (más el ingest de Prometheus, total ~70). Por eso, en un trial, el Grafana es lo primero que se apaga cuando no se está mirando, y la regla general es destruir el entorno apenas se captura la evidencia o se cierra la ventana de uso.

El detalle de la capa de observabilidad y su costo está en [Observabilidad](Observabilidad.md); el procedimiento concreto de teardown (incluyendo qué borrar de lo que se creó por `az` y en qué orden) está en el runbook de [Operacion](Operacion.md).

## La recomendación para el trial

Resumiendo la postura de FinOps en este contexto: etiquetar todo desde el día uno para que el costo sea atribuible, tener el budget con alertas como red de seguridad, y mantener la disciplina de apagar lo que no se usa. En la práctica eso significa destruir el stack (o al menos el Grafana, que es el de mayor costo flat) entre sesiones de demo, en vez de dejarlo prendido quemando crédito. Las decisiones de costo que tomamos en cada componente (control plane Free, nodos en la serie D por la restricción de la serie B, edge en Cloudflare free, base in-cluster en vez de administrada) están contadas en las páginas de [Arquitectura](Arquitectura-cloud.md) y los procedimientos; acá nos quedamos con la foto del gasto y cómo se imputa.

## Evidencia

> <font color="#9a6700">**Pendiente:**</font> la captura de Azure Cost Management con el gasto agrupado por tag queda fuera de scope por ahora; se toma cuando haya costo acumulado en la suscripcion. Lo que ya esta aplicado: las etiquetas de costeo en cada recurso (`project`, `owner`; se ven con `az resource list -g devsu-rg --query "[].tags"`) y el budget definido como IaC en [finops.tf](https://github.com/gcamargot/devsu-challenge/blob/master/terraform/finops.tf), gateado en `budget_contact_emails` (se activa cargando un email de contacto).
