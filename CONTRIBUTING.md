# Contributing to DevShare

## Development Workflow

### Initial Setup

1. **Prerequisites**
   ```bash
   # Install Node.js 18+
   # Install Rust toolchain
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   
   # Install pnpm
   npm install -g pnpm@8
   ```

2. **Clone and Install**
   ```bash
   git clone <repo-url>
   cd devshare
   pnpm install
   ```

3. **Build All Packages**
   ```bash
   pnpm build
   ```

### Development Commands

```bash
# Build all packages
pnpm build

# Watch mode for development
pnpm dev

# Run tests
pnpm test

# Lint and format
pnpm lint

# Clean build artifacts
pnpm clean

# Type checking
pnpm typecheck
```

### Package-Specific Development

#### Proto Package (Shared Types)
```bash
cd packages/proto
pnpm build        # Compile TypeScript
pnpm dev          # Watch mode
```

#### Native Addon (Rust)
```bash
cd packages/native
pnpm build        # Build release version
pnpm build:debug  # Build debug version
pnpm test         # Run Rust tests
```

#### Daemon (Node.js Service)
```bash
cd packages/daemon
pnpm build        # Build with esbuild
pnpm dev          # Watch mode
pnpm start        # Run daemon
```

#### Extension (VS Code)
```bash
cd packages/extension
pnpm build        # Build with webpack
pnpm dev          # Watch mode
pnpm package      # Create .vsix package
```

## Architecture Guidelines

### Code Organization

- **packages/proto**: Shared types, constants, interfaces
- **packages/native**: Performance-critical crypto/compression
- **packages/daemon**: Business logic, database, networking
- **packages/extension**: VS Code UI, commands, tree provider

### API Design

- Use JSON-RPC 2.0 for extension ↔ daemon communication
- All types defined in proto package
- Async/await for all operations
- Proper error handling with specific error codes

### Security Principles

- Never log sensitive data (keys, secrets)
- Validate all inputs at API boundaries
- Use cryptographically secure random generation
- Audit all security-relevant operations

### Performance Guidelines

- Use streaming for large file operations
- Implement backpressure for data flows
- Cache expensive computations
- Profile memory usage in long-running operations

## Testing Strategy

### Unit Tests
```bash
# Run all tests
pnpm test

# Test specific package
cd packages/daemon && pnpm test
```

### Integration Tests
```bash
# End-to-end daemon + extension tests
pnpm test:e2e
```

### Manual Testing
1. Start daemon: `cd packages/daemon && pnpm start`
2. Install extension in VS Code
3. Test ping command: `DevShare: Ping Daemon`

## Code Style

### TypeScript
- Use strict mode
- Prefer interfaces over types
- Use async/await over Promises
- Document public APIs with JSDoc

### Rust
- Follow standard Rust conventions
- Use `cargo fmt` and `cargo clippy`
- Write tests for all public functions
- Handle errors explicitly

### Commit Messages
```
feat: add project sharing functionality
fix: resolve WebSocket connection issues
docs: update API documentation
test: add unit tests for crypto module
refactor: simplify database schema
```

## Release Process

### Version Management
- Use semantic versioning (semver)
- Update all package.json versions together
- Tag releases in git

### Build Pipeline
1. Run all tests
2. Build all packages
3. Create extension .vsix
4. Publish to VS Code marketplace

## Debugging

### Daemon Debugging
```bash
# Enable debug logging
DEBUG=* pnpm start

# Or specific modules
DEBUG=devshare:* pnpm start
```

### Extension Debugging
1. Open VS Code
2. Go to Run and Debug
3. Select "Launch Extension"
4. Use Developer Tools for WebSocket inspection

### Native Addon Debugging
```bash
# Build debug version
pnpm build:debug

# Run with debug symbols
node --inspect-brk test-script.js
```

## Common Issues

### Build Failures
- Ensure Rust toolchain is installed
- Check Node.js version (18+ required)
- Clear node_modules and reinstall

### WebSocket Connection Issues
- Verify daemon is running on port 7681
- Check firewall settings
- Look for port conflicts

### Native Addon Issues
- Rebuild native modules: `pnpm rebuild`
- Check platform compatibility
- Verify Rust version compatibility

## Getting Help

- Check existing issues on GitHub
- Review documentation in README.md
- Ask questions in discussions
- Join development chat (if available)

## Pull Request Guidelines

1. **Before Starting**
   - Check existing issues and PRs
   - Discuss large changes in issues first
   - Fork the repository

2. **Development**
   - Create feature branch from main
   - Write tests for new functionality
   - Update documentation as needed
   - Follow code style guidelines

3. **Submission**
   - Ensure all tests pass
   - Update CHANGELOG.md
   - Write clear PR description
   - Link related issues

4. **Review Process**
   - Address reviewer feedback
   - Keep PR focused and atomic
   - Squash commits before merge

## Security Reporting

For security vulnerabilities, please email security@devshare.dev instead of creating public issues.
