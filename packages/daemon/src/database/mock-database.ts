import { Logger } from '../utils/logger';

const logger = new Logger('mock-database');

export class MockDatabase {
  private projects: any[] = [];
  private peers: any[] = [];
  private auditLog: any[] = [];
  private portRegistry = new Map<number, string>();

  async initialize(): Promise<void> {
    logger.info('Initializing mock database...');
    logger.info('Mock database initialized successfully');
  }

  async close(): Promise<void> {
    logger.info('Closing mock database connection');
  }

  async logAuditEvent(eventType: string, projectId?: string, peerId?: string, data?: any): Promise<void> {
    this.auditLog.push({
      eventType,
      projectId: projectId || null,
      peerId: peerId || null,
      data: data ? JSON.stringify(data) : null,
      timestamp: new Date().toISOString()
    });
  }

  async allocatePort(projectId: string, preferredPort?: number): Promise<number> {
    const startPort = preferredPort || 3000;
    const maxPort = 65535;

    for (let port = startPort; port <= maxPort; port++) {
      if (!this.portRegistry.has(port)) {
        this.portRegistry.set(port, projectId);
        return port;
      }
    }

    throw new Error('No available ports');
  }

  async releasePort(port: number): Promise<void> {
    this.portRegistry.delete(port);
  }

  // Mock methods for compatibility
  getProjects() {
    return this.projects;
  }

  getPeers() {
    return this.peers;
  }

  getAuditLog() {
    return this.auditLog;
  }
}
