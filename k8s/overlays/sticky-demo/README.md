# Sticky sessions (mejora / demo)

Demuestra afinidad de sesión: ingress-nginx setea una cookie (`devsu-affinity`)
que fija a cada cliente a la misma réplica. El Deployment se escala a 3 réplicas.
Es una de las mejoras propuestas en la wiki:
[Posibles-mejoras](https://gcamargot.github.io/devsu-challenge/Posibles-mejoras/).

```bash
kubectl apply -k k8s/overlays/sticky-demo
# las requests con la misma cookie caen siempre en el mismo pod:
curl -ksI https://devsu.local/api/users | grep -i set-cookie
```

## Por qué se descarta `sessionAffinity: ClientIP` del Service

Detrás del ingress, el Service ve la IP del **controller**, no la del cliente real,
así que `ClientIP` colapsa toda la afinidad a un solo origen. Por eso la afinidad se
hace en L7 (cookie) en el ingress.

## Nota honesta

La app es **stateless** y comparte estado en Postgres, así que la afinidad acá no es
necesaria para correctitud: es una demostración del mecanismo. La variante "3 apps
distintas (Node/Python/Java) detrás de un mismo LB con el cliente siempre al mismo
backend" se implementaría igual con cookie affinity, pero fragmentaría datos si cada
app tuviera su propia DB; la respuesta productiva real es mantener las apps stateless
contra una DB compartida (como acá), no forzar afinidad.
