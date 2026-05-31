// HTTP Basic Auth gate for the whole provisioner (UI + API). The single admin
// credential is read from PROVISIONER_USER / PROVISIONER_PASSWORD (delivered as
// ACA secrets — never baked into the image). Health/readiness probes are left
// open so the platform can still reach them.
import { timingSafeEqual } from "node:crypto";

const REALM = "Devsu Provisioner";
const OPEN_PATHS = new Set(["/health", "/ready"]);

// Constant-time compare that tolerates different lengths without leaking which
// field mismatched.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) {
    // Compare against self so the work is still constant-time-ish, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function basicAuth(req, res, next) {
  if (OPEN_PATHS.has(req.path)) return next();

  const expectedUser = process.env.PROVISIONER_USER;
  const expectedPass = process.env.PROVISIONER_PASSWORD;

  // If creds aren't configured, fail closed — better to lock everyone out than
  // to silently run an open admin tool.
  if (!expectedUser || !expectedPass) {
    res.status(503).send("auth not configured (PROVISIONER_USER / PROVISIONER_PASSWORD missing)");
    return;
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    return challenge(res);
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const pass = sep === -1 ? "" : decoded.slice(sep + 1);

  const ok = safeEqual(user, expectedUser) & safeEqual(pass, expectedPass);
  if (!ok) return challenge(res);

  // Stash the authenticated user for the audit log.
  req.authUser = user;
  next();
}

function challenge(res) {
  res.set("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
  res.status(401).send("Authentication required.");
}
