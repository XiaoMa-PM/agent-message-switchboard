# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |
| Earlier | No |

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: [report a vulnerability](https://github.com/XiaoMa-PM/agent-message-switchboard/security/advisories/new), or open this repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Useful details:

- the Agent Message Switchboard version (`ms --version`), your macOS version and the harness versions involved;
- what an attacker can do, and from where: another process of the same user, another user on the same Mac, a web page in a browser, or a letter from another session;
- steps to reproduce, with synthetic data rather than real session ids, paths or message contents.

Areas we treat as security-relevant include the identity checks that decide which process may register or send, the `act` risk tiering, the private root's file permissions, and the `ms ui` status page.
