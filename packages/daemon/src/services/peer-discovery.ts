import { createSocket, Socket } from 'dgram';
import { networkInterfaces } from 'os';
import { Logger } from '../utils/logger';
import { CryptoService } from './crypto-service';

const logger = new Logger('peer-discovery');

export interface DiscoveredPeer {
  id: string;
  name: string;
  address: string;
  port: number;
  publicKey: string;
  lastSeen: Date;
}

export interface PeerAnnouncement {
  type: 'peer_announcement';
  id: string;
  name: string;
  port: number;
  publicKey: string;
  timestamp: number;
  signature: string;
}

export interface BundleAnnouncement {
  type: 'bundle_announcement';
  peerId: string;
  bundleId: string;
  bundleName: string;
  bundleSize: number;
  timestamp: number;
  signature: string;
}

export type DiscoveryMessage = PeerAnnouncement | BundleAnnouncement;

export class PeerDiscoveryService {
  private socket: Socket | null = null;
  private cryptoService: CryptoService;
  private discoveredPeers = new Map<string, DiscoveredPeer>();
  private isRunning = false;
  
  // Configuration
  private readonly DISCOVERY_PORT = 7683;
  private readonly BROADCAST_INTERVAL = 30000; // 30 seconds
  private readonly PEER_TIMEOUT = 90000; // 90 seconds
  private readonly MULTICAST_ADDRESS = '239.255.42.99';
  
  // Event callbacks
  private onPeerDiscovered?: (peer: DiscoveredPeer) => void;
  private onPeerLost?: (peerId: string) => void;
  private onBundleAnnounced?: (announcement: BundleAnnouncement) => void;
  
  // Timers
  private broadcastTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(cryptoService: CryptoService) {
    this.cryptoService = cryptoService;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    logger.info('Starting UDP peer discovery service...');

    try {
      // Create UDP socket
      this.socket = createSocket({ type: 'udp4', reuseAddr: true });
      
      // Set up socket event handlers
      this.socket.on('message', this.handleMessage.bind(this));
      this.socket.on('error', this.handleError.bind(this));
      this.socket.on('listening', () => {
        const address = this.socket!.address();
        logger.info(`UDP discovery listening on ${address.address}:${address.port}`);
        
        // Join multicast group
        try {
          this.socket!.addMembership(this.MULTICAST_ADDRESS);
          logger.info(`Joined multicast group ${this.MULTICAST_ADDRESS}`);
        } catch (error) {
          logger.warn(`Failed to join multicast group: ${error}`);
        }
      });

      // Bind to discovery port
      await new Promise<void>((resolve, reject) => {
        this.socket!.bind(this.DISCOVERY_PORT, () => {
          resolve();
        });
        this.socket!.on('error', reject);
      });

      // Start periodic broadcasting
      this.startBroadcasting();
      
      // Start cleanup timer
      this.startCleanup();
      
      this.isRunning = true;
      logger.info('UDP peer discovery service started successfully');
      
    } catch (error) {
      logger.error(`Failed to start peer discovery: ${error}`);
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping UDP peer discovery service...');

    // Stop timers
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Close socket
    if (this.socket) {
      try {
        this.socket.dropMembership(this.MULTICAST_ADDRESS);
      } catch (error) {
        // Ignore errors when dropping membership
      }
      
      this.socket.close();
      this.socket = null;
    }

    // Clear discovered peers
    this.discoveredPeers.clear();
    
    this.isRunning = false;
    logger.info('UDP peer discovery service stopped');
  }

  // Event handlers
  onPeerDiscoveredEvent(callback: (peer: DiscoveredPeer) => void): void {
    this.onPeerDiscovered = callback;
  }

  onPeerLostEvent(callback: (peerId: string) => void): void {
    this.onPeerLost = callback;
  }

  onBundleAnnouncedEvent(callback: (announcement: BundleAnnouncement) => void): void {
    this.onBundleAnnounced = callback;
  }

  // Public methods
  getDiscoveredPeers(): DiscoveredPeer[] {
    return Array.from(this.discoveredPeers.values());
  }

  async announcePeer(): Promise<void> {
    if (!this.isRunning || !this.socket) {
      return;
    }

    try {
      const publicKey = await this.cryptoService.getPublicKey();
      const peerId = publicKey.substring(0, 16);
      const hostname = require('os').hostname();
      
      const announcement: PeerAnnouncement = {
        type: 'peer_announcement',
        id: peerId,
        name: `DevShare-${hostname}`,
        port: 7682, // Transfer service port
        publicKey,
        timestamp: Date.now(),
        signature: '' // Will be filled below
      };

      // Sign the announcement
      const messageToSign = JSON.stringify({
        type: announcement.type,
        id: announcement.id,
        name: announcement.name,
        port: announcement.port,
        publicKey: announcement.publicKey,
        timestamp: announcement.timestamp
      });
      
      const signature = await this.cryptoService.signMessage(messageToSign);
      announcement.signature = signature.signature;

      // Broadcast to multicast group
      const message = Buffer.from(JSON.stringify(announcement));
      this.socket.send(message, this.DISCOVERY_PORT, this.MULTICAST_ADDRESS);
      
      logger.debug(`Announced peer ${peerId} to network`);
      
    } catch (error) {
      logger.error(`Failed to announce peer: ${error}`);
    }
  }

  async announceBundle(bundleId: string, bundleName: string, bundleSize: number): Promise<void> {
    if (!this.isRunning || !this.socket) {
      return;
    }

    try {
      const publicKey = await this.cryptoService.getPublicKey();
      const peerId = publicKey.substring(0, 16);
      
      const announcement: BundleAnnouncement = {
        type: 'bundle_announcement',
        peerId,
        bundleId,
        bundleName,
        bundleSize,
        timestamp: Date.now(),
        signature: '' // Will be filled below
      };

      // Sign the announcement
      const messageToSign = JSON.stringify({
        type: announcement.type,
        peerId: announcement.peerId,
        bundleId: announcement.bundleId,
        bundleName: announcement.bundleName,
        bundleSize: announcement.bundleSize,
        timestamp: announcement.timestamp
      });
      
      const signature = await this.cryptoService.signMessage(messageToSign);
      announcement.signature = signature.signature;

      // Broadcast to multicast group
      const message = Buffer.from(JSON.stringify(announcement));
      this.socket.send(message, this.DISCOVERY_PORT, this.MULTICAST_ADDRESS);
      
      logger.info(`Announced bundle ${bundleId} (${bundleName}) to network`);
      
    } catch (error) {
      logger.error(`Failed to announce bundle: ${error}`);
    }
  }

  // Private methods
  private startBroadcasting(): void {
    // Announce immediately
    this.announcePeer();
    
    // Then announce periodically
    this.broadcastTimer = setInterval(() => {
      this.announcePeer();
    }, this.BROADCAST_INTERVAL);
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredPeers();
    }, 30000); // Check every 30 seconds
  }

  private cleanupExpiredPeers(): void {
    const now = Date.now();
    const expiredPeers: string[] = [];
    
    for (const [peerId, peer] of this.discoveredPeers) {
      if (now - peer.lastSeen.getTime() > this.PEER_TIMEOUT) {
        expiredPeers.push(peerId);
      }
    }
    
    for (const peerId of expiredPeers) {
      this.discoveredPeers.delete(peerId);
      logger.info(`Peer ${peerId} timed out and removed`);
      
      if (this.onPeerLost) {
        this.onPeerLost(peerId);
      }
    }
  }

  private async handleMessage(message: Buffer, rinfo: any): Promise<void> {
    try {
      const data: DiscoveryMessage = JSON.parse(message.toString());
      
      // Ignore our own messages
      const ourPublicKey = await this.cryptoService.getPublicKey();
      const ourPeerId = ourPublicKey.substring(0, 16);
      
      if (data.type === 'peer_announcement') {
        if (data.id === ourPeerId) {
          return; // Ignore our own announcements
        }
        
        await this.handlePeerAnnouncement(data, rinfo.address);
      } else if (data.type === 'bundle_announcement') {
        if (data.peerId === ourPeerId) {
          return; // Ignore our own bundle announcements
        }
        
        await this.handleBundleAnnouncement(data);
      }
      
    } catch (error) {
      logger.debug(`Failed to parse discovery message: ${error}`);
    }
  }

  private async handlePeerAnnouncement(announcement: PeerAnnouncement, sourceAddress: string): Promise<void> {
    try {
      // Verify signature
      const messageToVerify = JSON.stringify({
        type: announcement.type,
        id: announcement.id,
        name: announcement.name,
        port: announcement.port,
        publicKey: announcement.publicKey,
        timestamp: announcement.timestamp
      });
      
      const isValid = await this.cryptoService.verifySignature(
        messageToVerify,
        announcement.signature,
        announcement.publicKey
      );
      
      if (!isValid) {
        logger.warn(`Invalid signature in peer announcement from ${announcement.id}`);
        return;
      }
      
      // Check timestamp (reject messages older than 5 minutes)
      const messageAge = Date.now() - announcement.timestamp;
      if (messageAge > 5 * 60 * 1000) {
        logger.debug(`Ignoring old peer announcement from ${announcement.id}`);
        return;
      }
      
      // Update or add peer
      const existingPeer = this.discoveredPeers.get(announcement.id);
      const peer: DiscoveredPeer = {
        id: announcement.id,
        name: announcement.name,
        address: sourceAddress,
        port: announcement.port,
        publicKey: announcement.publicKey,
        lastSeen: new Date()
      };
      
      this.discoveredPeers.set(announcement.id, peer);
      
      // Notify if this is a new peer
      if (!existingPeer && this.onPeerDiscovered) {
        logger.info(`Discovered new peer: ${peer.name} (${peer.id}) at ${peer.address}:${peer.port}`);
        this.onPeerDiscovered(peer);
      }
      
    } catch (error) {
      logger.error(`Failed to handle peer announcement: ${error}`);
    }
  }

  private async handleBundleAnnouncement(announcement: BundleAnnouncement): Promise<void> {
    try {
      // Find the peer who announced this bundle
      const peer = this.discoveredPeers.get(announcement.peerId);
      if (!peer) {
        logger.debug(`Received bundle announcement from unknown peer ${announcement.peerId}`);
        return;
      }
      
      // Verify signature using peer's public key
      const messageToVerify = JSON.stringify({
        type: announcement.type,
        peerId: announcement.peerId,
        bundleId: announcement.bundleId,
        bundleName: announcement.bundleName,
        bundleSize: announcement.bundleSize,
        timestamp: announcement.timestamp
      });
      
      const isValid = await this.cryptoService.verifySignature(
        messageToVerify,
        announcement.signature,
        peer.publicKey
      );
      
      if (!isValid) {
        logger.warn(`Invalid signature in bundle announcement from ${announcement.peerId}`);
        return;
      }
      
      // Check timestamp
      const messageAge = Date.now() - announcement.timestamp;
      if (messageAge > 5 * 60 * 1000) {
        logger.debug(`Ignoring old bundle announcement from ${announcement.peerId}`);
        return;
      }
      
      logger.info(`Peer ${peer.name} announced bundle: ${announcement.bundleName} (${announcement.bundleId})`);
      
      if (this.onBundleAnnounced) {
        this.onBundleAnnounced(announcement);
      }
      
    } catch (error) {
      logger.error(`Failed to handle bundle announcement: ${error}`);
    }
  }

  private handleError(error: Error): void {
    logger.error(`UDP discovery socket error: ${error}`);
  }

  private getLocalNetworkInterfaces(): string[] {
    const interfaces = networkInterfaces();
    const addresses: string[] = [];
    
    for (const [name, nets] of Object.entries(interfaces)) {
      if (!nets) continue;
      
      for (const net of nets) {
        // Skip internal and IPv6 addresses
        if (!net.internal && net.family === 'IPv4') {
          addresses.push(net.address);
        }
      }
    }
    
    return addresses;
  }
}
