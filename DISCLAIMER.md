# Disclaimer

**B-Mud Tools** (“B-Mud”) is an independent open-source project. It is **not** affiliated with, endorsed by, or sponsored by Spotify AB, Google LLC, Apple Inc., HMD/Nokia, KaiOS Technologies, xAI, or any other third party whose software or services may be used with this project.

## What this software is

- A **KaiOS handset UI** and optional **local Mac/Linux relay** that you run yourself.
- Integration glue that calls **APIs and tools you configure** (e.g. Spotify Web API with *your* OAuth tokens, local speech-to-text, iMessage helpers, maps providers, SSH).

## What this software is not

- Not an official Spotify, YouTube, Apple Music, or KaiOS client.
- Not a hosted streaming service. The maintainers do **not** provide music files, accounts, or public proxies for others.
- Not legal, medical, or professional advice.

## Your responsibilities

If you install or run B-Mud, **you** are responsible for:

1. Complying with the **terms of service** and **developer policies** of any third party you connect (Spotify, Google, Apple, Tailscale, carriers, etc.).
2. Complying with **copyright and other applicable law** in your jurisdiction.
3. Securing **your own secrets** (bridge tokens, OAuth tokens, API keys). Never commit them.
4. Understanding that **jailbreaking** or modifying a device may void warranties and may violate manufacturer or carrier terms.
5. Any **optional / experimental** features you explicitly enable (environment flags, forks, or local patches). Defaults in this repository aim for safer, API-oriented behavior.

## Optional features

Some advanced paths (for example experimental handset audio resolution beyond official previews and Spotify Connect) are **disabled by default** and documented as experimental. Enabling them is an operator choice and may conflict with third-party terms. See [docs/MUSIC.md](docs/MUSIC.md).

## No warranty / limitation of liability

The software is provided under the [MIT License](LICENSE) **“AS IS”**, without warranty of any kind. Authors and contributors are not liable for damages arising from use, misuse, or inability to use the software, including account bans, device issues, or legal claims related to third-party services.

## Reporting problems

- Product bugs: GitHub issues on this repository.
- Security: see [SECURITY.md](SECURITY.md).

By using this software you acknowledge that you have read this disclaimer and the license.
