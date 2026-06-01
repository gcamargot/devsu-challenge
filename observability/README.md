# Observabilidad

Monitoreo off-cluster del cluster `devsu-aks` con **Azure Monitor managed Prometheus**
(almacenamiento de métricas) y **Azure Managed Grafana** (dashboards). Ambos corren fuera
del cluster para no consumir el node pool del trial, que está al límite de quota. Adentro
del cluster solo corre el agente liviano `ama-metrics` más kube-state-metrics.

## Qué hay en esta carpeta

- `ama-metrics-settings-configmap.yaml`: ConfigMap con la keep-list de métricas. Ajusta el
  perfil de ingest del add-on (que por defecto descarta métricas) para reincorporar las que
  usa el dashboard, manteniendo el perfil mínimo por costo.
- `dashboards/devsu-environments.json`: JSON del dashboard, listo para reimportar.

```sh
az grafana dashboard create -n devsu-grafana -g devsu-rg --overwrite true \
  --title "Devsu - Ephemeral Environments & App" \
  --definition @observability/dashboards/devsu-environments.json
```

El detalle completo (dashboard, costo, decisiones de diseño) está en la wiki:
[Observabilidad](https://gcamargot.github.io/devsu-challenge/Observabilidad/).
