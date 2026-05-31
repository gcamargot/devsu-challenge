import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bootstrapKubeconfig } from "./bootstrap.js";
import { renderEnv, envNamespace, host as buildHost } from "./manifests.js";

bootstrapKubeconfig();
import { applyManifests, deleteNamespace, listEnvs, envStatus, countManagedEnvs } from "./kube.js";
import { expiresAtFrom } from "./ttl.js";
import { basicAuth } from "./auth.js";
import { audit, recentAudit } from "./audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.ENV_DOMAIN || "gcamargo.xyz";
const MAX_ENVS = Number(process.env.MAX_CONCURRENT_ENVS || 3);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Probes stay open; everything else (UI + API) is gated behind Basic Auth.
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/ready", (_req, res) => res.json({ status: "ok" }));

app.use(basicAuth);
app.use(express.static(join(__dirname, "..", "public")));

const isSlug = (s) => /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(s);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

// Human-friendly "time left" until expiry, e.g. "3h 12m" or "expired".
function timeLeft(expiresAt) {
  if (!expiresAt) return "";
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "expired";
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// One status pill describing pod readiness for an env.
function statePill(status) {
  if (!status || status.phase === "unknown") return `<span class="pill pill-unknown">unknown</span>`;
  const label = `${status.ready}/${status.pods} ready`;
  const cls = status.phase === "ready" ? "pill-ready" : "pill-pending";
  return `<span class="pill ${cls}">${label}</span>`;
}

// HTML fragment rendered into the htmx target after provisioning / on list refresh.
function envRow(e, status) {
  const url = `https://${esc(e.host)}`;
  const left = timeLeft(e.expiresAt);
  const expires = e.expiresAt ? `${new Date(e.expiresAt).toLocaleString()}` : "";
  return `<tr>
    <td>${esc(e.group || "")}</td>
    <td><a href="${url}" target="_blank" rel="noreferrer">${esc(e.host)}</a></td>
    <td><code>${esc(e.release || "")}</code></td>
    <td>${statePill(status)}</td>
    <td title="${esc(expires)}">${left ? `${esc(left)} left` : esc(expires)}</td>
    <td><button class="del" hx-delete="/api/environments/${esc(e.namespace)}"
        hx-target="#envs" hx-confirm="Destroy ${esc(e.namespace)}?">destroy</button></td>
  </tr>`;
}

async function envsTable() {
  const envs = await listEnvs();
  const count = envs.filter((e) => e.status !== "Terminating").length;
  const cap = `<tr class="capacity"><td colspan="6" class="muted">${count}/${MAX_ENVS} environments in use</td></tr>`;
  if (!envs.length) {
    return `<tbody id="envs"><tr><td colspan="6" class="muted">No environments yet.</td></tr>${cap}</tbody>`;
  }
  const rows = await Promise.all(
    envs.map(async (e) => envRow(e, await envStatus(e.namespace)))
  );
  return `<tbody id="envs">${rows.join("")}${cap}</tbody>`;
}

app.get("/api/environments", async (_req, res) => {
  try {
    res.send(await envsTable());
  } catch (err) {
    res.status(500).send(`<tbody id="envs"><tr><td colspan="6" class="err">${esc(err.message)}</td></tr></tbody>`);
  }
});

app.post("/api/environments", async (req, res) => {
  const user = req.authUser || "unknown";
  const group = String(req.body.group || "").trim();
  const appName = String(req.body.app || "users-api").trim();
  const release = String(req.body.release || "latest").trim();
  const subdomain = String(req.body.subdomain || "devsu-prod").trim().toLowerCase();
  const duration = String(req.body.duration || "1h").trim();

  try {
    if (!group) throw new Error("group is required");
    if (appName !== "users-api") throw new Error("unsupported app (only users-api)");
    if (!isSlug(subdomain)) throw new Error("subdomain must be a DNS label (lowercase alphanumerics + dashes)");
    if (!/^[a-zA-Z0-9._-]+$/.test(release)) throw new Error("invalid release tag");

    // Concurrency cap: never let more than MAX_ENVS managed envs exist at once.
    const current = await countManagedEnvs();
    if (current >= MAX_ENVS) {
      const msg = `concurrency limit reached: ${current}/${MAX_ENVS} environments already running. Destroy one (or wait for a TTL) before creating another.`;
      await audit({ user, group, app: appName, release, subdomain, action: "create", result: "error", message: msg });
      res
        .status(409)
        .send(`<div class="err">${esc(msg)}</div>` + (await envsTable().catch(() => "")));
      return;
    }

    const expiresAt = expiresAtFrom(duration); // validates duration too
    const namespace = envNamespace(group, subdomain);
    const host = buildHost(subdomain);

    const objects = renderEnv({
      namespace,
      host,
      release,
      group,
      subdomain,
      expiresAt,
      requestedBy: user,
    });
    await applyManifests(objects);

    await audit({ user, group, app: appName, release, subdomain, namespace, action: "create", result: "ok", message: `expires ${expiresAt}` });

    const banner = `<div class="ok">Provisioning <code>${esc(namespace)}</code> → <a href="https://${esc(host)}" target="_blank" rel="noreferrer">https://${esc(host)}</a> (image <code>${esc(release)}</code>, expires ${new Date(expiresAt).toLocaleString()}). Pods are starting…</div>`;
    res.send(banner + (await envsTable()));
  } catch (err) {
    await audit({ user, group, app: appName, release, subdomain, action: "create", result: "error", message: err.message });
    res
      .status(400)
      .send(`<div class="err">Failed: ${esc(err.message)}</div>` + (await envsTable().catch(() => "")));
  }
});

app.delete("/api/environments/:ns", async (req, res) => {
  const user = req.authUser || "unknown";
  const ns = req.params.ns;
  try {
    // Capture the env metadata before it disappears so the audit entry is complete.
    const envs = await listEnvs().catch(() => []);
    const e = envs.find((x) => x.namespace === ns) || {};
    await deleteNamespace(ns);
    await audit({ user, group: e.group, app: "users-api", release: e.release, subdomain: e.subdomain, namespace: ns, action: "destroy", result: "ok", message: "manual destroy" });
    res.send(await envsTable());
  } catch (err) {
    await audit({ user, namespace: ns, action: "destroy", result: "error", message: err.message });
    res.status(500).send(`<div class="err">${esc(err.message)}</div>` + (await envsTable().catch(() => "")));
  }
});

// Recent audit entries. JSON for tooling (?format=json), HTML fragment for the UI.
app.get("/audit", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const entries = await recentAudit(limit);
    if (req.query.format === "json") {
      res.json(entries);
      return;
    }
    res.send(auditTable(entries));
  } catch (err) {
    res.status(500).send(`<tbody id="audit"><tr><td colspan="6" class="err">${esc(err.message)}</td></tr></tbody>`);
  }
});

function auditTable(entries) {
  if (!entries.length) {
    return `<tbody id="audit"><tr><td colspan="6" class="muted">No audit entries yet.</td></tr></tbody>`;
  }
  const rows = entries
    .map((e) => {
      const cls = e.result === "ok" ? "" : "audit-err";
      const action = e.action === "create" ? "create" : "destroy";
      return `<tr class="${cls}">
        <td class="muted">${esc(new Date(e.timestamp).toLocaleString())}</td>
        <td>${esc(e.user)}</td>
        <td><code>${esc(action)}</code></td>
        <td>${esc(e.namespace || e.subdomain || "")}</td>
        <td><code>${esc(e.release || "")}</code></td>
        <td>${esc(e.result)}${e.message ? ` <span class="muted">— ${esc(e.message)}</span>` : ""}</td>
      </tr>`;
    })
    .join("");
  return `<tbody id="audit">${rows}</tbody>`;
}

app.listen(PORT, () => {
  console.log(`provisioner listening on :${PORT} (env domain *.${DOMAIN}, max ${MAX_ENVS} concurrent)`);
});
