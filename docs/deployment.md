# Hosting on Cloudflare Workers

Astro builds static files into `dist/`. Workers Static Assets serves these files
without a Worker script or an Astro adapter. Missing URLs return HTTP 404 instead
of the home page.

Workers Builds selects Bun from `bun.lock`. The `packageManager` field pins Bun
to 1.4.3, and `.node-version` pins Node to 24.19.0.

Before clicking **Deploy**, commit these deployment files and push them to the
connected production branch. Local changes are not available to Workers Builds.
Use these dashboard values:

| Field           | Value                    |
| --------------- | ------------------------ |
| Project name    | `neorp`                  |
| Root directory  | Repository root          |
| Build command   | `bun run build`          |
| Deploy command  | `bun run deploy`         |
| Preview command | `bun run deploy:preview` |
| Preview builds  | Enabled                  |

Workers initially selects the repository's default branch for production.
After creation, select the production branch under **Settings > Build > Branch control**.
Keep custom domains unconfigured until you verify the temporary `workers.dev` URL.

Both deployment commands use the installed Wrangler and expect an existing build
in `dist/`. For local inspection, run `bun run build`. Then run `bun run preview`.
The Astro preview command serves the build locally. `bun run deploy:preview`
uploads a Cloudflare Preview. Normal builds and previews exclude drafts and
future posts. Scheduled posts require a rebuild on or after their publication date.

References: [Astro deployment](https://docs.astro.build/en/guides/deploy/cloudflare/),
[Workers Static Assets](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#use-workers-static-assets-for-new-projects),
[SSG routing](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/),
[Preview builds](https://developers.cloudflare.com/workers/previews/examples/),
[build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/),
and [branch control](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/).
