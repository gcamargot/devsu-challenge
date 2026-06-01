# Users API (app)

API REST de usuarios en Node + Express. Maneja el recurso usuario con los campos `dni` y `name`, y expone healthchecks para Kubernetes.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/users` | Lista usuarios |
| GET | `/api/users/:id` | Obtiene un usuario |
| POST | `/api/users` | Crea un usuario (`{ "dni", "name" }`) |
| GET | `/health` | Liveness |
| GET | `/ready` | Readiness (verifica la DB) |

## Correr local

```bash
npm install
npm test
npm run test:coverage
```

Por Docker:

```bash
docker build -t users-api .
docker run -p 8000:8000 users-api
curl localhost:8000/health
```

## Variables de entorno

- `PORT`: puerto de escucha (default 8000).
- `DB_DIALECT`: `sqlite` o `postgres`.
- Para postgres: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.

Ver `.env.example` para los valores de referencia.

## Más detalle

- [App y contenedor](https://gcamargot.github.io/devsu-challenge/Procedimiento-1-app-y-contenedor/)
- [CI](https://gcamargot.github.io/devsu-challenge/Procedimiento-2-ci/)
