import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bootstrapKubeconfig } from "./bootstrap.js";
import { renderEnv, envNamespace, host as buildHost } from "./manifests.js";

bootstrapKubeconfig();
import { applyManifests, deleteNamespace, listEnvs, envStatus } from "./kube.js";
import { expiresAtFrom } from "./ttl.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.ENV_DOMAIN || "gcamargo.xyz";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/ready", (_req, res) => res.json({ status: "ok" }));

const isSlug = (s) => /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(s);

// HTML fragment rendered into the htmx target after provisioning / on list refresh.
function envRow(e, status) {
  const url = `https://${e.host}`;
  const ready = status ? `${status.ready}/${status.pods} ready` : "";
  return `<tr>
    <td>${e.group || ""}</td>
    <td><a href="${url}" target="_blank" rel="noreferrer">${e.host}</a></td>
    <td><code>${e.release || ""}</code></td>
    <td>${ready}</td>
    <td>${e.expiresAt ? new Date(e.expiresAt).toLocaleString() : ""}</td>
    <td><button class="del" hx-delete="/api/environments/${e.namespace}"
        hx-target="#envs" hx-confirm="Destroy ${e.namespace}?">destroy</button></td>
  </tr>`;
}

async function envsTable() {
  const envs = await listEnvs();
  if (!envs.length) return `<tbody id="envs"><tr><td colspan="6" class="muted">No environments yet.</td></tr></tbody>`;
  const rows = await Promise.all(
    envs.map(async (e) => envRow(e, await envStatus(e.namespace)))
  );
  return `<tbody id="envs">${rows.join("")}</tbody>`;
}

app.get("/api/environments", async (_req, res) => {
  try {
    res.send(await envsTable());
  } catch (err) {
    res.status(500).send(`<tbody id="envs"><tr><td colspan="6" class="err">${err.message}</td></tr></tbody>`);
  }
});

app.post("/api/environments", async (req, res) => {
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
      requestedBy: req.body.requestedBy || group,
    });
    await applyManifests(objects);

    const banner = `<div class="ok">Provisioning <code>${namespace}</code> → <a href="https://${host}" target="_blank" rel="noreferrer">https://${host}</a> (image <code>${release}</code>, expires ${new Date(expiresAt).toLocaleString()}). Pods are starting…</div>`;
    res.send(banner + (await envsTable()));
  } catch (err) {
    res
      .status(400)
      .send(`<div class="err">Failed: ${err.message}</div>` + (await envsTable().catch(() => "")));
  }
});

app.delete("/api/environments/:ns", async (req, res) => {
  try {
    await deleteNamespace(req.params.ns);
    res.send(await envsTable());
  } catch (err) {
    res.status(500).send(`<div class="err">${err.message}</div>` + (await envsTable().catch(() => "")));
  }
});

app.listen(PORT, () => {
  console.log(`provisioner listening on :${PORT} (env domain *.${DOMAIN})`);
});
