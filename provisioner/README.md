# Self-Service Provisioner

App chica de htmx + Node/Express que levanta entornos efímeros de Users API en
`<subdomain>.gcamargo.xyz`. Cada entorno tiene un TTL: cuando vence, se destruye solo.

Corre en Azure Container Apps detrás de Cloudflare, accesible en
**https://provisioner.gcamargo.xyz**.

## Uso

El formulario pide `group`, `app`, `release` (tag de imagen), `subdomain` y `duration`.
Toda la app está detrás de **Basic Auth**.

- Tope de **3 entornos concurrentes**: el cuarto intento se rechaza con HTTP 409.
- Validación **pre-flight**: si el subdominio está reservado o colisiona con un entorno
  existente, devuelve 409 y no crea nada.

Guía de uso completa: https://gcamargot.github.io/devsu-challenge/Self-service-provisioner/

## Correr local

```sh
cd provisioner
npm install
KUBECONFIG=/ruta/al/admin.kubeconfig \
  PROVISIONER_USER=devsu-admin PROVISIONER_PASSWORD='<password>' \
  npm start
# abrir http://localhost:8080
```

## Cómo funciona por dentro

El backend crea un namespace dedicado por entorno, renderiza el set de manifiestos
(Postgres + Users API + Ingress + NetworkPolicies) y lo aplica con `kubectl`. Un CronJob
reaper revisa las anotaciones de TTL y borra los namespaces vencidos.

Diseño e infraestructura: https://gcamargot.github.io/devsu-challenge/Procedimiento-6-provisioner/

Despliegue a Azure Container Apps: ver [`infra/README.md`](infra/README.md).
