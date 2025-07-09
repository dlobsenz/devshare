import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir, stat, unlink } from 'fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { URL } from 'url';
import { 
  Peer, 
  TransferProgress, 
  ProjectManifest,
  DevShareErrorCode 
} from '@devshare/proto';
import { FileBundler, BundleChunk } from './file-bundler';
import { CryptoService } from './crypto-service';
import { PeerDiscoveryService, DiscoveredPeer } from './peer-discovery';
import { Logger } from '../utils/logger';

const logger = new Logger('transfer-service');

export interface TransferConfig {
  port: number;
  discoveryMethod: 'auto' | 'manual' | 'broadcast';
  allowedInterfaces: string[];
  transferTimeout: number;
  chunkSize: number;
}

export interface BundleInfo {
  bundleId: string;
  manifest: ProjectManifest;
  bundlePath: string;
  size: number;
  chunks: number;
  checksum: string;
  signature: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface TransferState {
  transferId: string;
  bundleId: string;
  peerId: string;
  direction: 'upload' | 'download';
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';
  totalChunks: number;
  completedChunks: Set<number>;
  totalBytes: number;
  transferredBytes: number;
  startTime: Date;
  tempPath?: string;
  error?: string;
}

export interface PeerInfo {
  id: string;
  name: string;
  address: string;
  port: number;
  publicKey: string;
  lastSeen: Date;
  online: boolean;
}

export class TransferService {
  private httpServer: ReturnType<typeof createServer>;
  private config: TransferConfig;
  private fileBundler: FileBundler;
  private cryptoService: CryptoService;
  private peerDiscovery: PeerDiscoveryService;
  
  // State management
  private availableBundles = new Map<string, BundleInfo>();
  private activeTransfers = new Map<string, TransferState>();
  private discoveredPeers = new Map<string, PeerInfo>();
  private transferTokens = new Map<string, { bundleId: string; peerId: string; expiresAt: Date }>();
  
  // Event callbacks
  private onTransferProgress?: (progress: TransferProgress) => void;
  private onPeerDiscovered?: (peer: PeerInfo) => void;
  private onPeerLost?: (peerId: string) => void;

  constructor(config: Partial<TransferConfig> = {}) {
    this.config = {
      port: 7682,
      discoveryMethod: 'auto',
      allowedInterfaces: ['en0', 'eth0', 'wlan0'],
      transferTimeout: 300, // 5 minutes
      chunkSize: 4 * 1024 * 1024, // 4MB
      ...config
    };
    
    this.fileBundler = new FileBundler();
    this.cryptoService = new CryptoService();
    this.peerDiscovery = new PeerDiscoveryService(this.cryptoService);
    this.httpServer = createServer(this.handleHttpRequest.bind(this));
  }

  async initialize(): Promise<void> {
    logger.info(`Initializing transfer service on port ${this.config.port}`);
    
    try {
      // Start HTTP server
      await new Promise<void>((resolve, reject) => {
        this.httpServer.listen(this.config.port, '0.0.0.0', () => {
          logger.info(`Transfer HTTP server listening on port ${this.config.port}`);
          resolve();
        });
        
        this.httpServer.on('error', reject);
      });
      
      // Start peer discovery
      if (this.config.discoveryMethod === 'auto' || this.config.discoveryMethod === 'broadcast') {
        await this.startPeerDiscovery();
      }
      
      // Start cleanup timer for expired bundles and tokens
      setInterval(() => this.cleanupExpired(), 60000); // Every minute
      
      logger.info('Transfer service initialized successfully');
      
    } catch (error) {
      logger.error(`Failed to initialize transfer service: ${error}`);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down transfer service...');
    
    // Stop peer discovery
    await this.peerDiscovery.stop();
    
    // Cancel all active transfers
    for (const [transferId, transfer] of this.activeTransfers) {
      await this.cancelTransfer(transferId);
    }
    
    // Close HTTP server
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => {
        logger.info('Transfer HTTP server closed');
        resolve();
      });
    });
    
    logger.info('Transfer service shutdown complete');
  }

  // Event handlers
  onTransferProgressChanged(callback: (progress: TransferProgress) => void): void {
    this.onTransferProgress = callback;
  }

  onPeerDiscoveredEvent(callback: (peer: PeerInfo) => void): void {
    this.onPeerDiscovered = callback;
  }

  onPeerLostEvent(callback: (peerId: string) => void): void {
    this.onPeerLost = callback;
  }

  // Bundle management
  async announceBundle(bundleId: string, bundlePath: string, manifest: ProjectManifest): Promise<void> {
    logger.info(`Announcing bundle ${bundleId} for sharing`);
    
    try {
      const bundleStats = await stat(bundlePath);
      const bundleData = await readFile(bundlePath);
      const checksum = createHash('sha256').update(bundleData).digest('hex');
      
      // Sign bundle
      const bundleHash = this.cryptoService.generateBundleHash(bundleData);
      const signature = await this.cryptoService.signBundle(bundlePath, bundleHash);
      
      // Calculate chunks
      const chunks = Math.ceil(bundleStats.size / this.config.chunkSize);
      
      const bundleInfo: BundleInfo = {
        bundleId,
        manifest,
        bundlePath,
        size: bundleStats.size,
        chunks,
        checksum,
        signature: signature.signature,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
      };
      
      this.availableBundles.set(bundleId, bundleInfo);
      
      // Broadcast availability to peers
      await this.broadcastBundleAvailability(bundleInfo);
      
      logger.info(`Bundle ${bundleId} announced successfully`);
      
    } catch (error) {
      logger.error(`Failed to announce bundle ${bundleId}: ${error}`);
      throw error;
    }
  }

  async requestBundle(peerId: string, bundleId: string): Promise<string> {
    logger.info(`Requesting bundle ${bundleId} from peer ${peerId}`);
    
    const peer = this.discoveredPeers.get(peerId);
    if (!peer || !peer.online) {
      throw new Error(`Peer ${peerId} not available`);
    }
    
    const transferId = `transfer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Request transfer token from peer
      const tokenResponse = await this.requestTransferToken(peer, bundleId);
      
      // Initialize transfer state
      const transferState: TransferState = {
        transferId,
        bundleId,
        peerId,
        direction: 'download',
        status: 'pending',
        totalChunks: tokenResponse.chunks,
        completedChunks: new Set(),
        totalBytes: tokenResponse.size,
        transferredBytes: 0,
        startTime: new Date(),
        tempPath: join(tmpdir(), 'devshare', 'transfers', `${transferId}.bundle`)
      };
      
      this.activeTransfers.set(transferId, transferState);
      
      // Start download
      await this.downloadBundle(peer, bundleId, tokenResponse.token, transferState);
      
      return transferId;
      
    } catch (error) {
      logger.error(`Failed to request bundle ${bundleId} from peer ${peerId}: ${error}`);
      
      // Update transfer state with error
      const transferState = this.activeTransfers.get(transferId);
      if (transferState) {
        transferState.status = 'failed';
        transferState.error = error instanceof Error ? error.message : 'Unknown error';
        this.notifyTransferProgress(transferState);
      }
      
      throw error;
    }
  }

  async getTransferProgress(transferId: string): Promise<TransferProgress | null> {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) {
      return null;
    }
    
    const elapsed = Date.now() - transfer.startTime.getTime();
    const speed = elapsed > 0 ? (transfer.transferredBytes / elapsed) * 1000 : 0;
    const remaining = transfer.totalBytes - transfer.transferredBytes;
    const eta = speed > 0 ? remaining / speed : 0;
    
    return {
      transferId: transfer.transferId,
      bundleId: transfer.bundleId,
      totalChunks: transfer.totalChunks,
      completedChunks: transfer.completedChunks.size,
      totalBytes: transfer.totalBytes,
      transferredBytes: transfer.transferredBytes,
      speed,
      eta,
      status: transfer.status,
      error: transfer.error
    };
  }

  async cancelTransfer(transferId: string): Promise<void> {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) {
      return;
    }
    
    logger.info(`Cancelling transfer ${transferId}`);
    
    transfer.status = 'cancelled';
    
    // Clean up temp files
    if (transfer.tempPath && existsSync(transfer.tempPath)) {
      try {
        await unlink(transfer.tempPath);
      } catch (error) {
        logger.warn(`Failed to clean up temp file ${transfer.tempPath}: ${error}`);
      }
    }
    
    this.activeTransfers.delete(transferId);
    this.notifyTransferProgress(transfer);
  }

  // Peer management
  async discoverPeers(): Promise<PeerInfo[]> {
    // Get peers from UDP discovery
    const discoveredPeers = this.peerDiscovery.getDiscoveredPeers();
    
    // Convert to PeerInfo format and update local cache
    for (const peer of discoveredPeers) {
      const peerInfo: PeerInfo = {
        id: peer.id,
        name: peer.name,
        address: peer.address,
        port: peer.port,
        publicKey: peer.publicKey,
        lastSeen: peer.lastSeen,
        online: true
      };
      this.discoveredPeers.set(peer.id, peerInfo);
    }
    
    return Array.from(this.discoveredPeers.values()).filter(peer => peer.online);
  }

  async addManualPeer(address: string, port: number, name?: string): Promise<void> {
    logger.info(`Adding manual peer at ${address}:${port}`);
    
    try {
      // Try to connect and get peer info
      const peerInfo = await this.getPeerInfo(address, port);
      
      const peer: PeerInfo = {
        id: peerInfo.id,
        name: name || peerInfo.name,
        address,
        port,
        publicKey: peerInfo.publicKey,
        lastSeen: new Date(),
        online: true
      };
      
      this.discoveredPeers.set(peer.id, peer);
      
      if (this.onPeerDiscovered) {
        this.onPeerDiscovered(peer);
      }
      
      logger.info(`Manual peer added: ${peer.name} (${peer.id})`);
      
    } catch (error) {
      logger.error(`Failed to add manual peer ${address}:${port}: ${error}`);
      throw error;
    }
  }

  // HTTP request handler
  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    
    try {
      // Set CORS headers for local development
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }
      
      // Route requests
      if (url.pathname === '/api/peer-info' && req.method === 'GET') {
        await this.handlePeerInfoRequest(req, res);
      } else if (url.pathname === '/api/bundles' && req.method === 'GET') {
        await this.handleListBundlesRequest(req, res);
      } else if (url.pathname === '/api/transfer/token' && req.method === 'POST') {
        await this.handleTransferTokenRequest(req, res);
      } else if (url.pathname.startsWith('/api/transfer/') && req.method === 'GET') {
        await this.handleBundleDownloadRequest(req, res, url);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      
    } catch (error) {
      logger.error(`HTTP request error: ${error}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private async handlePeerInfoRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const publicKey = await this.cryptoService.getPublicKey();
    
    const peerInfo = {
      id: publicKey.substring(0, 16), // Use first 16 chars of public key as ID
      name: `DevShare-${require('os').hostname()}`,
      publicKey,
      version: '0.1.0'
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(peerInfo));
  }

  private async handleListBundlesRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bundles = Array.from(this.availableBundles.values()).map(bundle => ({
      bundleId: bundle.bundleId,
      manifest: bundle.manifest,
      size: bundle.size,
      chunks: bundle.chunks,
      createdAt: bundle.createdAt.toISOString()
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ bundles }));
  }

  private async handleTransferTokenRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readRequestBody(req);
    const { bundleId, peerId } = JSON.parse(body);
    
    const bundle = this.availableBundles.get(bundleId);
    if (!bundle) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bundle not found' }));
      return;
    }
    
    // Generate one-time transfer token
    const token = createHash('sha256')
      .update(`${bundleId}:${peerId}:${Date.now()}:${Math.random()}`)
      .digest('hex');
    
    const expiresAt = new Date(Date.now() + this.config.transferTimeout * 1000);
    this.transferTokens.set(token, { bundleId, peerId, expiresAt });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      token,
      size: bundle.size,
      chunks: bundle.chunks,
      expiresAt: expiresAt.toISOString()
    }));
  }

  private async handleBundleDownloadRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const pathParts = url.pathname.split('/');
    const token = pathParts[3];
    const chunkIndex = pathParts[4] ? parseInt(pathParts[4]) : undefined;
    
    // Validate token
    const tokenInfo = this.transferTokens.get(token);
    if (!tokenInfo || tokenInfo.expiresAt < new Date()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired token' }));
      return;
    }
    
    const bundle = this.availableBundles.get(tokenInfo.bundleId);
    if (!bundle) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bundle not found' }));
      return;
    }
    
    try {
      if (chunkIndex !== undefined) {
        // Download specific chunk
        await this.sendBundleChunk(res, bundle, chunkIndex);
      } else {
        // Download entire bundle
        await this.sendEntireBundle(res, bundle);
      }
    } catch (error) {
      logger.error(`Failed to send bundle data: ${error}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Transfer failed' }));
    }
  }

  // Helper methods
  private async sendBundleChunk(res: ServerResponse, bundle: BundleInfo, chunkIndex: number): Promise<void> {
    const chunkStart = chunkIndex * this.config.chunkSize;
    const chunkEnd = Math.min(chunkStart + this.config.chunkSize - 1, bundle.size - 1);
    const chunkSize = chunkEnd - chunkStart + 1;
    
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': chunkSize.toString(),
      'Content-Range': `bytes ${chunkStart}-${chunkEnd}/${bundle.size}`,
      'X-Chunk-Index': chunkIndex.toString(),
      'X-Chunk-Checksum': '' // TODO: Calculate chunk checksum
    });
    
    const fileStream = createReadStream(bundle.bundlePath, { start: chunkStart, end: chunkEnd });
    fileStream.pipe(res);
  }

  private async sendEntireBundle(res: ServerResponse, bundle: BundleInfo): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': bundle.size.toString(),
      'X-Bundle-Checksum': bundle.checksum,
      'X-Bundle-Signature': bundle.signature
    });
    
    const fileStream = createReadStream(bundle.bundlePath);
    fileStream.pipe(res);
  }

  private async downloadBundle(peer: PeerInfo, bundleId: string, token: string, transfer: TransferState): Promise<void> {
    logger.info(`Starting download of bundle ${bundleId} from ${peer.address}:${peer.port}`);
    
    try {
      // Ensure temp directory exists
      await mkdir(dirname(transfer.tempPath!), { recursive: true });
      
      transfer.status = 'transferring';
      this.notifyTransferProgress(transfer);
      
      // Download bundle (for now, download entire bundle - chunking can be added later)
      const response = await fetch(`http://${peer.address}:${peer.port}/api/transfer/${token}`);
      
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }
      
      const totalSize = parseInt(response.headers.get('content-length') || '0');
      transfer.totalBytes = totalSize;
      
      const writeStream = createWriteStream(transfer.tempPath!);
      const reader = response.body?.getReader();
      
      if (!reader) {
        throw new Error('Failed to get response reader');
      }
      
      let downloadedBytes = 0;
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        writeStream.write(value);
        downloadedBytes += value.length;
        transfer.transferredBytes = downloadedBytes;
        
        // Update progress every 1MB or 5%
        if (downloadedBytes % (1024 * 1024) === 0 || 
            downloadedBytes / totalSize >= (transfer.completedChunks.size + 1) * 0.05) {
          this.notifyTransferProgress(transfer);
        }
      }
      
      writeStream.end();
      
      transfer.status = 'completed';
      this.notifyTransferProgress(transfer);
      
      logger.info(`Bundle ${bundleId} downloaded successfully`);
      
    } catch (error) {
      transfer.status = 'failed';
      transfer.error = error instanceof Error ? error.message : 'Unknown error';
      this.notifyTransferProgress(transfer);
      throw error;
    }
  }

  private async requestTransferToken(peer: PeerInfo, bundleId: string): Promise<{ token: string; size: number; chunks: number }> {
    const publicKey = await this.cryptoService.getPublicKey();
    const peerId = publicKey.substring(0, 16);
    
    const response = await fetch(`http://${peer.address}:${peer.port}/api/transfer/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundleId, peerId })
    });
    
    if (!response.ok) {
      throw new Error(`Token request failed: ${response.status} ${response.statusText}`);
    }
    
    return await response.json() as { token: string; size: number; chunks: number };
  }

  private async getPeerInfo(address: string, port: number): Promise<{ id: string; name: string; publicKey: string }> {
    const response = await fetch(`http://${address}:${port}/api/peer-info`);
    
    if (!response.ok) {
      throw new Error(`Peer info request failed: ${response.status} ${response.statusText}`);
    }
    
    return await response.json() as { id: string; name: string; publicKey: string };
  }

  private async startPeerDiscovery(): Promise<void> {
    logger.info('Starting UDP peer discovery...');
    
    // Set up peer discovery event handlers
    this.peerDiscovery.onPeerDiscoveredEvent((peer: DiscoveredPeer) => {
      const peerInfo: PeerInfo = {
        id: peer.id,
        name: peer.name,
        address: peer.address,
        port: peer.port,
        publicKey: peer.publicKey,
        lastSeen: peer.lastSeen,
        online: true
      };
      
      this.discoveredPeers.set(peer.id, peerInfo);
      
      if (this.onPeerDiscovered) {
        this.onPeerDiscovered(peerInfo);
      }
    });
    
    this.peerDiscovery.onPeerLostEvent((peerId: string) => {
      const peer = this.discoveredPeers.get(peerId);
      if (peer) {
        peer.online = false;
        if (this.onPeerLost) {
          this.onPeerLost(peerId);
        }
      }
    });
    
    // Start the UDP discovery service
    await this.peerDiscovery.start();
  }

  private async broadcastBundleAvailability(bundle: BundleInfo): Promise<void> {
    logger.info(`Broadcasting availability of bundle ${bundle.bundleId}`);
    
    // Announce bundle via UDP discovery
    await this.peerDiscovery.announceBundle(
      bundle.bundleId,
      bundle.manifest.name,
      bundle.size
    );
  }

  private notifyTransferProgress(transfer: TransferState): void {
    if (this.onTransferProgress) {
      const elapsed = Date.now() - transfer.startTime.getTime();
      const speed = elapsed > 0 ? (transfer.transferredBytes / elapsed) * 1000 : 0;
      const remaining = transfer.totalBytes - transfer.transferredBytes;
      const eta = speed > 0 ? remaining / speed : 0;
      
      const progress: TransferProgress = {
        transferId: transfer.transferId,
        bundleId: transfer.bundleId,
        totalChunks: transfer.totalChunks,
        completedChunks: transfer.completedChunks.size,
        totalBytes: transfer.totalBytes,
        transferredBytes: transfer.transferredBytes,
        speed,
        eta,
        status: transfer.status,
        error: transfer.error
      };
      
      this.onTransferProgress(progress);
    }
  }

  private async readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private cleanupExpired(): void {
    const now = new Date();
    
    // Clean up expired bundles
    for (const [bundleId, bundle] of this.availableBundles) {
      if (bundle.expiresAt < now) {
        this.availableBundles.delete(bundleId);
        logger.info(`Expired bundle ${bundleId} cleaned up`);
      }
    }
    
    // Clean up expired tokens
    for (const [token, tokenInfo] of this.transferTokens) {
      if (tokenInfo.expiresAt < now) {
        this.transferTokens.delete(token);
      }
    }
    
    // Clean up old transfers
    for (const [transferId, transfer] of this.activeTransfers) {
      const age = Date.now() - transfer.startTime.getTime();
      if (age > this.config.transferTimeout * 1000 && 
          (transfer.status === 'completed' || transfer.status === 'failed' || transfer.status === 'cancelled')) {
        this.activeTransfers.delete(transferId);
      }
    }
  }
}
