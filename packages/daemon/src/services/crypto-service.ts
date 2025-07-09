import { createHash, randomBytes, pbkdf2Sync, createCipher, createDecipher } from 'crypto';
import { Logger } from '../utils/logger';

const logger = new Logger('crypto-service');

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface SignatureResult {
  signature: string;
  publicKey: string;
}

export interface BundleSignature {
  bundleHash: string;
  signature: string;
  publicKey: string;
  timestamp: number;
  version: string;
}

export class CryptoService {
  private keyPair: KeyPair | null = null;

  constructor() {
    this.initializeKeys();
  }

  private async initializeKeys(): Promise<void> {
    try {
      // Try to use native Rust addon first
      try {
        const native = require('@devshare/native');
        this.keyPair = await native.generateKeyPair();
        logger.info('Initialized Ed25519 keys using native addon');
      } catch (error) {
        // Fallback to JavaScript implementation
        logger.warn('Native addon not available, using JavaScript fallback');
        this.keyPair = this.generateKeyPairFallback();
      }
    } catch (error) {
      logger.error(`Failed to initialize crypto keys: ${error}`);
      throw error;
    }
  }

  private generateKeyPairFallback(): KeyPair {
    // Simple fallback using Node.js crypto (not Ed25519, but functional for testing)
    const privateKey = randomBytes(32).toString('hex');
    const publicKey = createHash('sha256').update(privateKey).digest('hex');
    
    return {
      privateKey,
      publicKey
    };
  }

  async signBundle(bundlePath: string, bundleHash: string): Promise<BundleSignature> {
    if (!this.keyPair) {
      throw new Error('Crypto service not initialized');
    }

    try {
      let signature: string;

      // Try native implementation first
      try {
        const native = require('@devshare/native');
        signature = await native.signData(bundleHash, this.keyPair.privateKey);
      } catch (error) {
        // Fallback to JavaScript implementation
        signature = this.signDataFallback(bundleHash, this.keyPair.privateKey);
      }

      const bundleSignature: BundleSignature = {
        bundleHash,
        signature,
        publicKey: this.keyPair.publicKey,
        timestamp: Date.now(),
        version: '1.0.0'
      };

      logger.info(`Bundle signed: ${bundleHash.substring(0, 8)}...`);
      return bundleSignature;

    } catch (error) {
      logger.error(`Failed to sign bundle: ${error}`);
      throw error;
    }
  }

  async verifyBundleSignature(bundleHash: string, signature: BundleSignature): Promise<boolean> {
    try {
      // Verify timestamp (not older than 24 hours)
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      if (Date.now() - signature.timestamp > maxAge) {
        logger.warn('Bundle signature expired');
        return false;
      }

      // Verify hash matches
      if (bundleHash !== signature.bundleHash) {
        logger.warn('Bundle hash mismatch');
        return false;
      }

      let isValid: boolean;

      // Try native verification first
      try {
        const native = require('@devshare/native');
        isValid = await native.verifySignature(
          signature.bundleHash,
          signature.signature,
          signature.publicKey
        );
      } catch (error) {
        // Fallback to JavaScript verification
        isValid = this.verifySignatureFallback(
          signature.bundleHash,
          signature.signature,
          signature.publicKey
        );
      }

      if (isValid) {
        logger.info(`Bundle signature verified: ${signature.publicKey.substring(0, 8)}...`);
      } else {
        logger.warn('Bundle signature verification failed');
      }

      return isValid;

    } catch (error) {
      logger.error(`Failed to verify bundle signature: ${error}`);
      return false;
    }
  }

  private signDataFallback(data: string, privateKey: string): string {
    // Simple HMAC-based signing for fallback
    return createHash('sha256')
      .update(data + privateKey)
      .digest('hex');
  }

  private verifySignatureFallback(data: string, signature: string, publicKey: string): boolean {
    // Reconstruct private key from public key (this is just for testing)
    // In real implementation, this would use proper Ed25519 verification
    const expectedSignature = createHash('sha256')
      .update(data + publicKey) // Using publicKey as proxy for privateKey in fallback
      .digest('hex');
    
    return signature === expectedSignature;
  }

  getPublicKey(): string {
    if (!this.keyPair) {
      throw new Error('Crypto service not initialized');
    }
    return this.keyPair.publicKey;
  }

  async encryptData(data: string, recipientPublicKey: string): Promise<string> {
    try {
      // Try native implementation first
      try {
        const native = require('@devshare/native');
        return await native.encryptData(data, recipientPublicKey);
      } catch (error) {
        // Fallback to simple base64 encoding (not secure, just for testing)
        logger.warn('Using insecure fallback encryption');
        return Buffer.from(data).toString('base64');
      }
    } catch (error) {
      logger.error(`Failed to encrypt data: ${error}`);
      throw error;
    }
  }

  async decryptData(encryptedData: string, senderPublicKey: string): Promise<string> {
    try {
      // Try native implementation first
      try {
        const native = require('@devshare/native');
        return await native.decryptData(encryptedData, senderPublicKey);
      } catch (error) {
        // Fallback to simple base64 decoding
        logger.warn('Using insecure fallback decryption');
        return Buffer.from(encryptedData, 'base64').toString('utf-8');
      }
    } catch (error) {
      logger.error(`Failed to decrypt data: ${error}`);
      throw error;
    }
  }

  generateBundleHash(bundleData: Buffer): string {
    return createHash('sha256').update(bundleData).digest('hex');
  }

  generateSecureToken(): string {
    return randomBytes(32).toString('hex');
  }

  async signMessage(message: string): Promise<SignatureResult> {
    if (!this.keyPair) {
      throw new Error('Crypto service not initialized');
    }

    try {
      let signature: string;

      // Try native implementation first
      try {
        const native = require('@devshare/native');
        signature = await native.signData(message, this.keyPair.privateKey);
      } catch (error) {
        // Fallback to JavaScript implementation
        signature = this.signDataFallback(message, this.keyPair.privateKey);
      }

      return {
        signature,
        publicKey: this.keyPair.publicKey
      };

    } catch (error) {
      logger.error(`Failed to sign message: ${error}`);
      throw error;
    }
  }

  async verifySignature(message: string, signature: string, publicKey: string): Promise<boolean> {
    try {
      let isValid: boolean;

      // Try native verification first
      try {
        const native = require('@devshare/native');
        isValid = await native.verifySignature(message, signature, publicKey);
      } catch (error) {
        // Fallback to JavaScript verification
        isValid = this.verifySignatureFallback(message, signature, publicKey);
      }

      return isValid;

    } catch (error) {
      logger.error(`Failed to verify signature: ${error}`);
      return false;
    }
  }

  async deriveKey(password: string, salt: string): Promise<Buffer> {
    try {
      // Try native implementation first
      try {
        const native = require('@devshare/native');
        return native.deriveKey(password, salt);
      } catch (error) {
        // Fallback to Node.js PBKDF2
        logger.warn('Using Node.js PBKDF2 for key derivation');
        return pbkdf2Sync(password, salt, 100000, 32, 'sha256');
      }
    } catch (error) {
      logger.error(`Failed to derive key: ${error}`);
      throw error;
    }
  }

  encrypt(data: string, key: Buffer): string {
    try {
      // Try native implementation first
      try {
        const native = require('@devshare/native');
        return native.encryptAesGcm(Buffer.from(data), key).toString('base64');
      } catch (error) {
        // Fallback to Node.js cipher
        logger.warn('Using Node.js cipher for encryption');
        const cipher = createCipher('aes-256-cbc', key);
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
      }
    } catch (error) {
      logger.error(`Failed to encrypt data: ${error}`);
      throw error;
    }
  }

  decrypt(encryptedData: string, key: Buffer): string {
    try {
      // Try native implementation first
      try {
        const native = require('@devshare/native');
        return native.decryptAesGcm(Buffer.from(encryptedData, 'base64'), key).toString('utf8');
      } catch (error) {
        // Fallback to Node.js decipher
        logger.warn('Using Node.js decipher for decryption');
        const decipher = createDecipher('aes-256-cbc', key);
        let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }
    } catch (error) {
      logger.error(`Failed to decrypt data: ${error}`);
      throw error;
    }
  }
}
