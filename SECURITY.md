# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest (main) | Yes |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report via one of the following:

1. **GitHub Security Advisories** — [Report a vulnerability](https://github.com/MrCipherSmith/multiclaude-tg-bot/security/advisories/new) (preferred)
2. **Email** — contact the maintainer via their GitHub profile

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment** — within 48 hours
- **Assessment** — within 7 days
- **Fix or mitigation** — as soon as possible, depending on severity

## Security Considerations

This project handles sensitive data. When deploying, please ensure:

- **`.env` files** are never committed (already in `.gitignore`)
- **`ALLOWED_USERS`** is set to restrict bot access to authorized Telegram users only
- **Database** is not exposed to the public network
- **Webhook secret** (`TELEGRAM_WEBHOOK_SECRET`) is set when using webhook transport
- **API keys** (Anthropic, OpenRouter, Google AI, Groq) are kept private
- **Dashboard authentication** uses Telegram Login Widget — only `ALLOWED_USERS` can access

## Scope

The following are in scope for security reports:

- Authentication/authorization bypass
- Injection vulnerabilities (SQL, command, XSS)
- Sensitive data exposure
- MCP protocol security issues
- Telegram webhook validation bypass

The following are out of scope:

- Denial of service (the bot is designed for single-user/small-team use)
- Social engineering
- Issues in third-party dependencies (report these upstream)
