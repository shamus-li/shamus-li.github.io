# Redirect manager

This Vite app builds the `/redirects/` shadcn/ui frontend. It talks to Cloudflare Pages Functions under `/api/redirects/*`, which validate Cloudflare Access JWTs and use the `REDIRECTS_KV` Workers KV binding for redirect rules.

## Commands

```bash
npm --prefix redirects run lint
npm --prefix redirects run build
```

The root build command runs the redirects build and assembles the deployable Cloudflare Pages output in `dist/`.

## Cloudflare setup

Create a Cloudflare Access application that protects both `/redirects*` and `/api/redirects*`. Configure that Access policy to require your passkey-capable login method, such as an IdP passkey login or Access independent MFA with a WebAuthn security key. Then set these Pages variables:

```text
ACCESS_TEAM_DOMAIN=https://<team-name>.cloudflareaccess.com
ACCESS_AUD=<Access application audience tag>
```

Add a Workers KV binding named `REDIRECTS_KV` to the Pages project. The app validates the Access JWT and stores redirect rules in that KV namespace.
