import { createRemoteJWKSet, jwtVerify } from "jose";

const jwksByDomain = new Map();

export async function requireAccess({ env, request }) {
  if (isLocalRequest(request)) {
    return {
      email: "local-dev@localhost",
      name: "Local dev",
      local: true,
    };
  }

  const domain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  if (!domain || !env.ACCESS_AUD) {
    throw accessError("Cloudflare Access is not configured", 403);
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw accessError("Cloudflare Access token required", 401);

  const jwks = getJwks(domain);
  const { payload } = await jwtVerify(token, jwks, {
    audience: env.ACCESS_AUD,
    issuer: domain,
  });

  return {
    email: typeof payload.email === "string" ? payload.email : "",
    name: typeof payload.name === "string" ? payload.name : "",
    sub: typeof payload.sub === "string" ? payload.sub : "",
    local: false,
  };
}

export function accessErrorResponse(err, request) {
  const status = err.status || 403;
  if (new URL(request.url).pathname.startsWith("/api/")) {
    return new Response(
      JSON.stringify({ error: err.message || "Access denied" }),
      {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }
  return new Response(err.message || "Access denied", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function getJwks(domain) {
  if (!jwksByDomain.has(domain)) {
    jwksByDomain.set(
      domain,
      createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`)),
    );
  }
  return jwksByDomain.get(domain);
}

function normalizeTeamDomain(value) {
  if (!value) return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

function isLocalRequest(request) {
  const hostname = new URL(request.url).hostname;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".localhost")
  );
}

function accessError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}
