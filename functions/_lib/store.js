const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_LIST_NAME = "pages_to_custom_domain";

export async function listRedirects(env) {
  const config = await configFor(env);
  const items = await readListItems(config);

  return items.filter((item) => isManagedItem(item, config.hostname)).map((item) => ({
    id: item.id,
    source: pathFromSourceUrl(item.redirect.source_url, config.hostname),
    destination: item.redirect.target_url,
    code: item.redirect.status_code || 301,
  }));
}

export async function replaceRedirects(env, redirects) {
  const config = await configFor(env);
  const existingItems = await readListItems(config);
  const unmanagedItems = existingItems.filter(
    (item) => !isManagedItem(item, config.hostname),
  );
  const operation = await cf(
    config,
    "PUT",
    `/rules/lists/${config.list.id}/items`,
    [...unmanagedItems.map(itemForWrite), ...redirects.map((rule) => itemFromRule(rule, config))],
  );

  await waitForOperation(config, operation.operation_id);
  return redirects;
}

async function readListItems(config) {
  const items = [];
  let cursor = "";

  do {
    const query = new URLSearchParams({ per_page: "500" });
    if (cursor) query.set("cursor", cursor);
    const page = await cf(
      config,
      "GET",
      `/rules/lists/${config.list.id}/items?${query}`,
      true,
    );
    items.push(...page.result);
    cursor = page.result_info?.cursors?.after || "";
  } while (cursor);

  return items;
}

async function configFor(env) {
  const config = {
    accountId: required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID"),
    token: required(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN"),
    hostname: required(env.REDIRECT_HOSTNAME, "REDIRECT_HOSTNAME")
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, ""),
    listName: env.REDIRECT_LIST_NAME || DEFAULT_LIST_NAME,
  };
  const lists = await cf(config, "GET", "/rules/lists");
  const list = lists.find((entry) => entry.kind === "redirect" && entry.name === config.listName);
  if (!list) throw requestError(`Cloudflare Bulk Redirect List "${config.listName}" was not found`, 500);
  return { ...config, list };
}

async function waitForOperation(config, operationId) {
  if (!operationId) return;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const operation = await cf(config, "GET", `/rules/lists/bulk_operations/${operationId}`);
    if (operation.status === "completed") return;
    if (operation.status === "failed") {
      throw requestError(operation.error || "Cloudflare redirect update failed", 502);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw requestError("Cloudflare redirect update did not finish in time", 504);
}

async function cf(config, method, path, envelope = false) {
  const body = Array.isArray(envelope) ? envelope : undefined;
  const response = await fetch(`${API_BASE}/accounts/${config.accountId}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success === false) {
    throw requestError(
      data.errors?.map((error) => error.message).join("; ") ||
        `${response.status} ${response.statusText}`,
      response.status,
    );
  }

  return envelope === true ? data : data.result;
}

function pathFromSourceUrl(sourceUrl, hostname) {
  const withoutScheme = sourceUrl.replace(/^https?:\/\//, "");
  if (withoutScheme === hostname) return "/";
  return withoutScheme.startsWith(`${hostname}/`)
    ? `/${withoutScheme.slice(hostname.length + 1)}`
    : `/${withoutScheme.replace(/^\/+/, "")}`;
}

function isManagedItem(item, hostname) {
  const sourceUrl = item.redirect?.source_url;
  if (!sourceUrl) return false;
  const withoutScheme = sourceUrl.replace(/^https?:\/\//, "");
  return withoutScheme === hostname || withoutScheme.startsWith(`${hostname}/`);
}

function itemFromRule(rule, config) {
  return {
    redirect: {
      source_url: `${config.hostname}${normalizePath(rule.source)}`,
      target_url: rule.destination,
      status_code: rule.code,
      preserve_query_string: false,
      preserve_path_suffix: false,
      subpath_matching: false,
      include_subdomains: false,
    },
  };
}

function itemForWrite(item) {
  const redirect = item.redirect;
  return {
    redirect: {
      source_url: redirect.source_url,
      target_url: redirect.target_url,
      status_code: redirect.status_code,
      preserve_query_string: Boolean(redirect.preserve_query_string),
      preserve_path_suffix: Boolean(redirect.preserve_path_suffix),
      subpath_matching: Boolean(redirect.subpath_matching),
      include_subdomains: Boolean(redirect.include_subdomains),
    },
  };
}

function normalizePath(source) {
  const trimmed = String(source || "").trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function required(value, name) {
  if (!value) throw requestError(`${name} is not configured`, 500);
  return value;
}

function requestError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
