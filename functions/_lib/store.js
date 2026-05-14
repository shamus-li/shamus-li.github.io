export const DEFAULT_REDIRECTS = [
  {
    source: "/4660-feedback",
    destination: "https://forms.gle/hM4a3iq7VX1szfd86",
    code: 301,
    active: true,
  },
  {
    source: "/4660-feedback/",
    destination: "https://forms.gle/hM4a3iq7VX1szfd86",
    code: 301,
    active: true,
  },
  {
    source: "/snack-rotation",
    destination:
      "https://docs.google.com/spreadsheets/d/1PLLapvCIgzZI-GHkF203iDKOuoID04lpvxVHUaqsl6E/edit?usp=sharing",
    code: 301,
    active: true,
  },
  {
    source: "/snack-rotation/",
    destination:
      "https://docs.google.com/spreadsheets/d/1PLLapvCIgzZI-GHkF203iDKOuoID04lpvxVHUaqsl6E/edit?usp=sharing",
    code: 301,
    active: true,
  },
  {
    source: "/words-of-wisdom",
    destination:
      "https://docs.google.com/document/d/1N5CbBP5Uez4s_DDrd-rBFKBBNVewKc0oDI8FeW7Kjzo/edit?usp=sharing",
    code: 301,
    active: true,
  },
  {
    source: "/words-of-wisdom/",
    destination:
      "https://docs.google.com/document/d/1N5CbBP5Uez4s_DDrd-rBFKBBNVewKc0oDI8FeW7Kjzo/edit?usp=sharing",
    code: 301,
    active: true,
  },
];

const REDIRECTS_KEY = "redirects";

function kv(env) {
  if (!env.REDIRECTS_KV) throw new Error("Missing REDIRECTS_KV binding");
  return env.REDIRECTS_KV;
}

export async function getJson(env, key) {
  return kv(env).get(key, "json");
}

export async function putJson(env, key, value, options) {
  return kv(env).put(key, JSON.stringify(value), options);
}

export async function getRedirects(env) {
  const stored = await getJson(env, REDIRECTS_KEY);
  if (stored) return stored;
  await putJson(env, REDIRECTS_KEY, DEFAULT_REDIRECTS);
  return DEFAULT_REDIRECTS;
}

export async function saveRedirects(env, redirects) {
  return putJson(env, REDIRECTS_KEY, redirects);
}

export async function findRedirect(env, pathname) {
  if (!env.REDIRECTS_KV)
    return DEFAULT_REDIRECTS.find(
      (rule) => rule.active && rule.source === pathname,
    );
  const redirects = await getRedirects(env);
  return redirects.find((rule) => rule.active && rule.source === pathname);
}
