# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.3.x | yes |
| older | no; upgrade first |

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
reporting instead: **Security → Report a vulnerability** on this repository
([direct link](https://github.com/mvalentsev/mimocode-mempalace/security/advisories/new)),
or e-mail michael@valentsev.ru.

Scope note: this plugin shells out to the `mempalace` CLI and reads MiMoCode's
SQLite database read-only. Vulnerabilities in MemPalace itself (palace storage,
mining, search) should go to the [MemPalace project](https://github.com/MemPalace/mempalace)
through its private advisory channel, not here.
