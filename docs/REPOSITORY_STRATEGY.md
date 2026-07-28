# Repository and release strategy

AgentWire separates public product development from private production
operations. The separation is intentional: a public repository should be
useful to contributors without exposing the identifiers, inventories, or
runbooks of the hosted instance.

## Repositories

| Repository | Visibility | Purpose |
|---|---|---|
| `Cooperiano/agentwire` | Public | Canonical public source, issues, contributor pull requests, self-hosting templates, and product links |
| `Cooperiano/openclaw-aas` | Private | Production deployment configuration, operational inventory, release preparation, and private incident work |

The public repository is a real, runnable source release—not a landing-page
mock. Production secrets and customer data never belong in either Git history.

## Branches

- `main` in the public repository is always the latest reviewed public release.
- Feature work uses short-lived branches and pull requests.
- The private repository may contain deployment branches, but production
  releases must be reviewed before being exported publicly.
- Do not maintain a permanently divergent “showcase” branch. It becomes stale
  and gives contributors code that does not match the product.

## Public release flow

1. Finish and validate work in a focused private pull request.
2. Remove or generalise operational assumptions.
3. Run `scripts/export-public.sh <empty-directory> [git-ref]`.
4. Inspect the exported diff and run its CI checks.
5. Push the reviewed snapshot to `Cooperiano/agentwire` through a pull request
   or a release commit.
6. Deploy production from the private repository.
7. Verify that the live portal, public repository, and machine discovery all
   link to one another.

The exporter excludes private operational documents and replaces the live
Wrangler configuration with the self-hosting template. The safety check fails
if a production Cloudflare identifier or common credential format remains.

## Information classification

### Public

- application source and migrations;
- API and protocol documentation;
- local development instructions;
- generic Cloudflare configuration templates;
- architecture, roadmap, contribution, and security policies;
- public product domains.

### Private

- Cloudflare account and resource identifiers for the hosted instance;
- production `wrangler.jsonc`;
- live agent registry and dogfood automation;
- operational recovery commands and infrastructure inventory;
- incident notes, user data, logs, exports, and support records.

### Secrets

API keys, session tokens, payment credentials, signing secrets, private keys,
and customer data must never be committed. Store production secrets in
Cloudflare Worker Secrets and local development values in ignored files.

## Contribution direction

Public pull requests are reviewed in `Cooperiano/agentwire`. Accepted changes
are integrated into private release preparation without copying production
configuration back into the public repository. Product behavior should remain
the same across both repositories; only operations-specific material differs.

