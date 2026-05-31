# Self-service provisioner: uso

El provisioner permite a un integrante del equipo levantar un entorno efímero de Users API en `<subdomain>.gcamargo.xyz` desde un formulario web, y lo destruye solo al vencer su TTL. Sirve para demos, QA de una rama o validar un release antes de promoverlo, sin tocar el entorno productivo. Acá va el how-to de uso; el por qué y la arquitectura están en [Procedimiento 6: provisioner self-service](Procedimiento-6-provisioner.md).

## Dónde está

El front corre en Azure Container Apps, fuera del clúster de aplicaciones, pero ya no se accede por la URL cruda de ACA: lo pusimos detrás de Cloudflare con un custom domain, así que la puerta de entrada es

https://provisioner.gcamargo.xyz

Es un CNAME proxied en Cloudflare que enmascara el origen en ACA (el mismo borde que sirve a la app productiva), con cert managed del lado de Container Apps. Se abre en el navegador, no hace falta nada instalado del lado del usuario.

## Login

El panel pide Basic Auth antes de mostrar nada (UI y API por igual). El usuario es `devsu-admin`; el password no se documenta acá y se entrega por separado al equipo.

> <font color="#cf222e">**Importante:**</font> las credenciales no viven en la imagen ni en el repo ni en esta wiki: se cargan como secrets de Azure Container Apps (`PROVISIONER_USER` / `PROVISIONER_PASSWORD`) y se leen en runtime. El password se comparte por un canal seguro, fuera de la documentación; si rotás el secret, rotás el login. Los únicos paths que quedan abiertos sin auth son `/health` y `/ready`, para que la plataforma pueda sondear el contenedor.

## Completar el formulario paso a paso

1. Abrir https://provisioner.gcamargo.xyz y pasar el Basic Auth (ver arriba). Vas a ver el formulario y, debajo, una tabla de entornos activos que se autorefresca.
2. **Group / Team**: el nombre del equipo (por ejemplo `payments`). Es texto libre y entra al nombre del namespace, así que conviene que sea descriptivo y corto.
3. **App**: dejarlo en `users-api` (es la única app soportada por ahora).
4. **Release (image tag)**: el tag de la imagen a desplegar. Puede ser `latest` o un tag por commit del CI, por ejemplo `sha-9948569`. Es el mismo tag que ves en GHCR/ACR, así que podés pedir exactamente la imagen que produjo un build concreto.
5. **Subdomain**: el subdominio público donde va a quedar el entorno. El default es `devsu-prod`, pero conviene cambiarlo a algo propio (por ejemplo `payments-qa`) para no pisar a otro. Tiene que ser una label DNS válida (minúsculas, números y guiones). El entorno queda en `<subdomain>.gcamargo.xyz`.
6. **Duration (TTL)**: cuánto vive el entorno antes de que el reaper lo borre. Las opciones del form son `30m`, `1h`, `4h`, `24h`. Elegí el plazo más corto que te alcance.
7. Click en **Provision**. Aparece un banner de confirmación con el link `https://<subdomain>.gcamargo.xyz` y el momento de expiración, y el entorno se suma a la tabla de activos con su conteo de pods (`x/y ready`).

> <font color="#9a6700">**Atencion:**</font> hay un tope de 3 entornos efímeros concurrentes. Si ya hay tres corriendo, el formulario devuelve HTTP 409 con un mensaje del estilo "concurrency limit reached: 3/3" y no crea nada. Es a propósito (el clúster del trial es chico y los entornos efímeros pasan por las mismas políticas de recursos que producción): hay que destruir uno, o esperar a que venza por TTL, antes de pedir el cuarto. La tabla muestra una fila `N/3 environments in use` para que sepas cuánto margen queda.

## La tabla de entornos activos

Debajo del formulario hay una tabla que se autorefresca (cada 15s) y es la fuente de verdad del estado, porque el provisioner no guarda una base de datos aparte: lee directo los namespaces gestionados del clúster. Por cada entorno se ve:

- el namespace (`env-<group>-<subdomain>`) y su host público,
- el estado de readiness como una pill `ready` o `x/y` pods (todos los pods listos vs. cuántos faltan),
- el TTL restante (cuánto le queda antes de que el reaper lo borre),
- la URL del entorno y el botón **destroy**.

Arriba o al pie de la tabla aparece la fila `N/3 environments in use`, el conteo contra el tope concurrente.

## El audit log

Toda acción de create y destroy queda registrada. El log es accesible en https://provisioner.gcamargo.xyz/audit (devuelve las entradas más recientes, las mismas que la UI muestra en su panel de auditoría). Cada línea anota quién (el usuario autenticado por Basic Auth), qué (group, app, release, subdomain, namespace), la acción y el resultado, con su timestamp.

> <font color="#0969da">**Nota:**</font> el log es persistente y compartido. Se escribe como JSONL en un Azure Files share que montan tanto el front en ACA como el reaper en AKS, así que los borrados automáticos por TTL (que los hace el reaper, no el front) caen en el mismo archivo que los creates manuales. El detalle de por qué quedó así está en [Procedimiento 6: provisioner self-service](Procedimiento-6-provisioner.md).

## Verificar que el entorno levantó

El entorno tarda un poco en estar accesible: tienen que arrancar postgres y la app (que espera a que la base responda), y cert-manager tiene que emitir el TLS del Ingress. En la tabla del front, esperá a que la columna de pods muestre todos Ready.

Desde la terminal, un curl al subdominio confirma que responde de punta a punta:

```bash
# liveness/readiness del entorno efimero
curl -sI https://<subdomain>.gcamargo.xyz/health
curl -s  https://<subdomain>.gcamargo.xyz/ready

# la API en si
curl -s https://<subdomain>.gcamargo.xyz/api/users
```

Como el host pasa por el wildcard proxied de Cloudflare (ver [Arquitectura](Arquitectura-cloud.md)), la respuesta debería traer el header `cf-ray`, igual que el entorno productivo.

Si tenés acceso al clúster, podés mirar el namespace directamente:

```bash
# el namespace del entorno y su expiresAt
kubectl get ns -l provisioner.devsu.io/managed=true
kubectl get ns env-<group>-<subdomain> \
  -o jsonpath='{.metadata.annotations.provisioner\.devsu\.io/expiresAt}'

# los recursos dentro del entorno
kubectl get pods,svc,ingress,networkpolicy -n env-<group>-<subdomain>
```

## Cómo se destruye

Hay dos caminos, y en los dos el teardown es atómico (se borra el namespace entero, no quedan recursos sueltos).

- **Automático (TTL):** el reaper, un CronJob que corre cada 5 minutos en el clúster, compara la anotación `provisioner.devsu.io/expiresAt` del namespace contra la hora actual y borra los vencidos. No hay que hacer nada: el entorno desaparece solo al cumplirse el plazo que elegiste, aunque nadie tenga el navegador abierto.
- **Manual (botón destroy):** en la tabla de entornos activos, cada fila tiene un botón **destroy** que pide confirmación y borra el entorno en el momento (pega un `DELETE /api/environments/<namespace>` en el backend). Útil cuando terminaste antes de tiempo y no querés esperar al TTL.

Como último recurso, con acceso al clúster se puede forzar el borrado a mano, que es lo mismo que hace el reaper:

```bash
kubectl delete ns env-<group>-<subdomain>
```

## Probarlo de punta a punta

Para una corrida completa, el camino que seguimos es este:

1. Abrir https://provisioner.gcamargo.xyz, pasar el Basic Auth (`devsu-admin` / la password del secret) y completar el form con un subdominio propio y un TTL corto (`30m` alcanza para una prueba).
2. Mirar la tabla: la pill de readiness arranca en `x/y` y debería llegar a `ready` cuando levantan postgres y la app. Verificar que la fila `N/3` subió en uno.
3. Pegarle al subdominio desde la terminal (ver más abajo) y confirmar que responde por HTTPS con header `cf-ray`.
4. Confirmar el tope: con tres entornos arriba, un cuarto Provision devuelve 409.
5. Borrar con el botón **destroy** (o esperar al TTL) y verificar que la fila desaparece de la tabla y que el create y el destroy quedaron en https://provisioner.gcamargo.xyz/audit.

## Evidencia

> <font color="#0969da">**Evidencia:**</font> espacio para pegar la corrida real de un entorno efímero creado y destruido (reemplazar por salida o captura):
>
> - Captura del formulario del provisioner ya completado y del banner de confirmación tras enviar, con la tabla mostrando la pill de readiness, el TTL restante y la fila `N/3`.
> - `curl -sI https://<subdomain>.gcamargo.xyz/health` (respuesta por HTTPS con header `cf-ray` presente).
> - Un cuarto Provision devolviendo HTTP 409 con el tope `3/3`.
> - El create y el destroy correspondientes en `https://provisioner.gcamargo.xyz/audit`.
> - `kubectl get ns -l provisioner.devsu.io/managed=true` mostrando el namespace `env-<group>-<subdomain>`.
> - `kubectl get ns env-<group>-<subdomain> -o jsonpath='{.metadata.annotations.provisioner\.devsu\.io/expiresAt}'` con la fecha de expiración.
>
> ```text
> (pegar aca la salida / captura)
> ```
