# DevShare

Secure, offline project sharing for VS Code teams.

## Overview

DevShare turns "copy my repo, fix env issues, hope it starts" into "one drag, one click, it runs exactly the same for everyone."

It gives every teammate a friction-free way to package, distribute, install, and run complete projects inside VS Code—fully offline, with cryptographic security, and zero cloud dependencies.

## Architecture

This is a monorepo containing:

- **packages/proto** - Shared TypeScript types and API contracts
- **packages/native** - Rust native addon for cryptography and compression
- **packages/daemon** - Node.js daemon service (WebSocket server)
- **packages/extension** - VS Code extension (client)

## Development Setup

### Prerequisites

- Node.js 18+
- Rust toolchain (for native addon)
- pnpm 8+

### Quick Start

```bash
# Clone and install dependencies
git clone <repo-url>
cd devshare
pnpm install

# Build all packages
pnpm build

# Start development
pnpm dev
```

### Package-specific commands

```bash
# Build proto types
cd packages/proto && pnpm build

# Build native addon
cd packages/native && pnpm build

# Build and run daemon
cd packages/daemon && pnpm build && pnpm start

# Build extension
cd packages/extension && pnpm build
```

## Current Status

🚀 **BETA TESTING PROGRAM LAUNCHED** - January 8, 2025:

- [x] Complete Share → Import → Run workflow
- [x] Intelligent project detection (React, Vue, Angular, Next.js, Python, Docker)
- [x] Secure bundle creation with cryptographic signing
- [x] Automatic dependency installation and process management
- [x] Real-time monitoring and audit logging
- [x] Production-ready core with security implementation
- [x] Comprehensive beta testing infrastructure
- [x] **LIVE BETA PROGRAM** - Join at `BETA_LAUNCH.md`

## MVP Features (Phase 1)

- Drag project folder → share → import → run workflow
- Ed25519 signatures + AES-GCM encryption
- Chunked file transfer with resumption
- Automatic Node.js/Python environment setup
- Port allocation and process management
- Basic vault for secrets

## Architecture Decisions

- **Monorepo**: Single PR = one logical change, shared types
- **Rust Native**: napi-rs for crypto/compression performance
- **WebSocket**: JSON-RPC 2.0 for extension ↔ daemon communication
- **SQLite**: Local storage for projects, peers, audit logs
- **Separate Daemon**: Isolation, privileges, hot-swap updates

## Security Model

- Ed25519 keypairs generated on first run
- Bundle signatures verified before import
- AES-GCM vault using OS keychain
- Immutable audit trail in SQLite
- Process isolation with limited permissions

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

MIT
