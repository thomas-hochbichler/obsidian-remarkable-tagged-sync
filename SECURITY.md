# Security Policy

## Supported Versions

Only the latest release on the Obsidian community plugin store receives security fixes. There are
no maintenance branches for older versions; updating the plugin is the fix.

## Reporting a Vulnerability

Please report vulnerabilities privately, not in a public issue:

- **Preferred:** GitHub's private reporting form at
  <https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync/security/advisories/new>
  (the "Report a vulnerability" button on the Security tab).
- **Alternative:** e-mail <support@hochbichler.com>.

You will get a first response within 7 days. Coordinated disclosure is the default: the report
stays private until a fixed release is on the store, and the fix is targeted within 90 days of the
report. Fixes ship as a patch release; the changelog names the vulnerability and the fixed version.

## Scope

In scope: the plugin's own code in this repository and the way it handles your reMarkable data,
API keys and local files. Vulnerabilities in third-party libraries the plugin bundles are handled
as described in [docs/DEVELOPING.md](docs/DEVELOPING.md), section *Dependencies and security*;
reporting them here is welcome if you believe the plugin is affected.
