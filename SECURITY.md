# Security policy

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities involving authentication,
payments, private orders, signed attachments, or data exposure. Use GitHub's
private vulnerability reporting feature for this repository.

Include:

- affected endpoint or component;
- reproduction steps;
- potential impact;
- whether credentials or personal data may be exposed.

Do not test against production accounts or access data that is not yours.

## Supported code

Security fixes target the current `main` branch. Research-preview deployments
may change without backward compatibility.

## Secrets and production data

The public repository must never contain `.env`, `.dev.vars`, API keys,
payment-provider secrets, exported databases, R2 objects, user content, or
production log archives. Secrets belong in Cloudflare Worker Secrets.

