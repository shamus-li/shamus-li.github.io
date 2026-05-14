# Redirect manager

This Vite app builds the `/redirects/` shadcn/ui frontend. It talks to Cloudflare Pages Functions under `/redirects/api/*`, which manage Cloudflare Bulk Redirect Lists through the Cloudflare API.

## Commands

```bash
npm --prefix redirects run lint
npm --prefix redirects run build
```

The root build command runs the redirects build and assembles the deployable Cloudflare Pages output in `dist/`.

## Cloudflare setup

Create a Cloudflare Access application that protects `/redirects*`. Configure that Access policy to require your Google login. Cloudflare Access owns the login cookie and session duration for both the dashboard and `/redirects/api`; set the Access application's session duration to control how long you stay signed in.

Set these Pages variables:

```text
CLOUDFLARE_ACCOUNT_ID=<Cloudflare account ID>
REDIRECT_HOSTNAME=shamus.li
REDIRECT_LIST_NAME=pages_to_custom_domain
```

Add a Pages secret named `CLOUDFLARE_API_TOKEN`. It needs permission to edit account filter lists. The dashboard uses the existing `pages_to_custom_domain` Bulk Redirect List and the existing Bulk Redirect Rule that already references it.
