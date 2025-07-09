import { Logger } from '../utils/logger';
import { CryptoService } from './crypto-service';

const logger = new Logger('secrets-vault');

export interface SecretEntry {
  id: string;
  name: string;
  value: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultConfig {
  keychain: boolean; // Use OS keychain integration
  encryption: boolean; // Use local encryption
  autoLock: boolean; // Auto-lock after inactivity
  lockTimeout: number; // Minutes before auto-lock
}

export class SecretsVault {
  private cryptoService: CryptoService;
  private config: VaultConfig;
  private secrets = new Map<string, SecretEntry>();
  private isLocked = true;
  private masterKey?: Buffer;
  private lockTimer?: NodeJS.Timeout;

  constructor(config: Partial<VaultConfig> = {}) {
    this.config = {
      keychain: true,
      encryption: true,
      autoLock: true,
      lockTimeout: 15, // 15 minutes
      ...config
    };
    
    this.cryptoService = new CryptoService();
  }

  async initialize(): Promise<void> {
    logger.info('Initializing secrets vault...');
    
    try {
      // Try to load existing vault from OS keychain
      if (this.config.keychain) {
        await this.loadFromKeychain();
      }
      
      logger.info('Secrets vault initialized successfully');
    } catch (error) {
      logger.error(`Failed to initialize secrets vault: ${error}`);
      throw error;
    }
  }

  async unlock(password?: string): Promise<boolean> {
    logger.info('Attempting to unlock secrets vault...');
    
    try {
      if (this.config.keychain) {
        // Use OS keychain authentication
        await this.unlockWithKeychain();
      } else if (password) {
        // Use password-based unlocking
        await this.unlockWithPassword(password);
      } else {
        throw new Error('Password required for vault unlock');
      }
      
      this.isLocked = false;
      this.startAutoLockTimer();
      
      logger.info('Secrets vault unlocked successfully');
      return true;
      
    } catch (error) {
      logger.error(`Failed to unlock vault: ${error}`);
      return false;
    }
  }

  lock(): void {
    logger.info('Locking secrets vault...');
    
    this.isLocked = true;
    this.masterKey = undefined;
    this.secrets.clear();
    
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = undefined;
    }
    
    logger.info('Secrets vault locked');
  }

  async storeSecret(name: string, value: string, description?: string): Promise<string> {
    if (this.isLocked) {
      throw new Error('Vault is locked');
    }
    
    const id = this.generateSecretId();
    const secret: SecretEntry = {
      id,
      name,
      value,
      description,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    this.secrets.set(id, secret);
    
    // Persist to keychain if enabled
    if (this.config.keychain) {
      await this.saveToKeychain();
    }
    
    this.resetAutoLockTimer();
    logger.info(`Secret '${name}' stored with ID: ${id}`);
    
    return id;
  }

  async getSecret(id: string): Promise<SecretEntry | null> {
    if (this.isLocked) {
      throw new Error('Vault is locked');
    }
    
    const secret = this.secrets.get(id);
    if (secret) {
      this.resetAutoLockTimer();
      logger.debug(`Retrieved secret: ${secret.name}`);
    }
    
    return secret || null;
  }

  async getSecretByName(name: string): Promise<SecretEntry | null> {
    if (this.isLocked) {
      throw new Error('Vault is locked');
    }
    
    for (const secret of this.secrets.values()) {
      if (secret.name === name) {
        this.resetAutoLockTimer();
        logger.debug(`Retrieved secret by name: ${name}`);
        return secret;
      }
    }
    
    return null;
  }

  async updateSecret(id: string, value: string, description?: string): Promise<boolean> {
    if (this.isLocked) {
      throw new Error('Vault is locked');
    }
    
    const secret = this.secrets.get(id);
    if (!secret) {
      return false;
    }
    
    secret.value = value;
    if (description !== undefined) {
      secret.description = description;
    }
    secret.updatedAt = new Date();
    
    // Persist to keychain if enabled
    if (this.config.keychain) {
      await this.saveToKeychain();
    }
    
    this.resetAutoLockTimer();
    logger.info(`Secret '${secret.name}' updated`);
    
    return true;
  }

  async deleteSecret(id: string): Promise<boolean> {
    if (this.isLocked) {
      throw new Error('Vault is locked');
    }
    
    const secret = this.secrets.get(id);
    if (!secret) {
      return false;
    }
    
    this.secrets.delete(id);
    
    // Persist to keychain if enabled
    if (this.config.keychain) {
      await this.saveToKeychain();
    }
    
    this.resetAutoLockTimer();
    logger.info(`Secret '${secret.name}' deleted`);
    
    return true;
  }

  async listSecrets(): Promise<Omit<SecretEntry, 'value'>[]> {
    if (this.isLocked) {
      throw new Error('Vault is locked');
    }
    
    this.resetAutoLockTimer();
    
    return Array.from(this.secrets.values()).map(secret => ({
      id: secret.id,
      name: secret.name,
      description: secret.description,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt
    }));
  }

  isVaultLocked(): boolean {
    return this.isLocked;
  }

  // OS Keychain Integration
  private async loadFromKeychain(): Promise<void> {
    try {
      // Try to use macOS keychain
      if (process.platform === 'darwin') {
        await this.loadFromMacOSKeychain();
      } else if (process.platform === 'win32') {
        await this.loadFromWindowsCredentialManager();
      } else if (process.platform === 'linux') {
        await this.loadFromLinuxKeyring();
      }
    } catch (error) {
      logger.warn(`Keychain integration not available: ${error}`);
      // Fall back to local storage
      this.config.keychain = false;
    }
  }

  private async saveToKeychain(): Promise<void> {
    if (!this.config.keychain) return;
    
    try {
      const vaultData = this.serializeVault();
      
      if (process.platform === 'darwin') {
        await this.saveToMacOSKeychain(vaultData);
      } else if (process.platform === 'win32') {
        await this.saveToWindowsCredentialManager(vaultData);
      } else if (process.platform === 'linux') {
        await this.saveToLinuxKeyring(vaultData);
      }
    } catch (error) {
      logger.error(`Failed to save to keychain: ${error}`);
      throw error;
    }
  }

  private async unlockWithKeychain(): Promise<void> {
    // OS keychain handles authentication
    await this.loadFromKeychain();
  }

  private async unlockWithPassword(password: string): Promise<void> {
    // Generate master key from password
    this.masterKey = await this.cryptoService.deriveKey(password, 'devshare-vault');
  }

  // Platform-specific keychain implementations
  private async loadFromMacOSKeychain(): Promise<void> {
    const { execSync } = require('child_process');
    
    try {
      const result = execSync(
        `security find-generic-password -s "DevShare-Vault" -w`,
        { encoding: 'utf8' }
      );
      
      const vaultData = result.trim();
      this.deserializeVault(vaultData);
      
    } catch (error) {
      // Vault doesn't exist yet, that's okay
      logger.debug('No existing vault found in macOS keychain');
    }
  }

  private async saveToMacOSKeychain(data: string): Promise<void> {
    const { execSync } = require('child_process');
    
    try {
      // Delete existing entry first
      try {
        execSync(`security delete-generic-password -s "DevShare-Vault"`);
      } catch {
        // Entry might not exist, ignore
      }
      
      // Add new entry
      execSync(
        `security add-generic-password -s "DevShare-Vault" -a "devshare" -w "${data}"`
      );
      
    } catch (error) {
      throw new Error(`Failed to save to macOS keychain: ${error}`);
    }
  }

  private async loadFromWindowsCredentialManager(): Promise<void> {
    // Windows Credential Manager integration would go here
    throw new Error('Windows Credential Manager not yet implemented');
  }

  private async saveToWindowsCredentialManager(data: string): Promise<void> {
    // Windows Credential Manager integration would go here
    throw new Error('Windows Credential Manager not yet implemented');
  }

  private async loadFromLinuxKeyring(): Promise<void> {
    // Linux keyring integration would go here
    throw new Error('Linux keyring not yet implemented');
  }

  private async saveToLinuxKeyring(data: string): Promise<void> {
    // Linux keyring integration would go here
    throw new Error('Linux keyring not yet implemented');
  }

  // Utility methods
  private generateSecretId(): string {
    return `secret_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private serializeVault(): string {
    const vaultData = {
      secrets: Array.from(this.secrets.entries()),
      version: '1.0.0',
      timestamp: new Date().toISOString()
    };
    
    const json = JSON.stringify(vaultData);
    
    if (this.config.encryption && this.masterKey) {
      // Encrypt vault data
      return this.cryptoService.encrypt(json, this.masterKey);
    }
    
    return json;
  }

  private deserializeVault(data: string): void {
    try {
      let json = data;
      
      if (this.config.encryption && this.masterKey) {
        // Decrypt vault data
        json = this.cryptoService.decrypt(data, this.masterKey);
      }
      
      const vaultData = JSON.parse(json);
      
      // Restore secrets
      this.secrets.clear();
      for (const [id, secret] of vaultData.secrets) {
        // Convert date strings back to Date objects
        secret.createdAt = new Date(secret.createdAt);
        secret.updatedAt = new Date(secret.updatedAt);
        this.secrets.set(id, secret);
      }
      
      logger.info(`Loaded ${this.secrets.size} secrets from vault`);
      
    } catch (error) {
      logger.error(`Failed to deserialize vault: ${error}`);
      throw error;
    }
  }

  private startAutoLockTimer(): void {
    if (!this.config.autoLock) return;
    
    this.lockTimer = setTimeout(() => {
      logger.info('Auto-locking vault due to inactivity');
      this.lock();
    }, this.config.lockTimeout * 60 * 1000);
  }

  private resetAutoLockTimer(): void {
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
    }
    this.startAutoLockTimer();
  }
}
