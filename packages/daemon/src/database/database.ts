import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { Logger } from '../utils/logger';

const logger = new Logger('database');

export class Database {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor() {
    const devShareDir = join(homedir(), '.devshare');
    if (!existsSync(devShareDir)) {
      mkdirSync(devShareDir, { recursive: true });
    }
    this.dbPath = join(devShareDir, 'devshare.db');
  }

  async initialize(): Promise<void> {
    logger.info(`Initializing database at ${this.dbPath}`);
    
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    
    await this.createTables();
    logger.info('Database initialized successfully');
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Projects table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        owner TEXT NOT NULL,
        path TEXT NOT NULL,
        manifest TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'stopped',
        port INTEGER,
        process_id TEXT,
        pid INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Peers table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        address TEXT
      )
    `);

    // Transfers table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        type TEXT NOT NULL, -- 'incoming' or 'outgoing'
        peer_id TEXT NOT NULL,
        total_chunks INTEGER NOT NULL,
        completed_chunks INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL,
        transferred_bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (peer_id) REFERENCES peers (id)
      )
    `);

    // Port registry table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS port_registry (
        port INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        allocated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects (id)
      )
    `);

    // Audit log table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        project_id TEXT,
        peer_id TEXT,
        data TEXT,
        timestamp TEXT NOT NULL
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner);
      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
      CREATE INDEX IF NOT EXISTS idx_transfers_bundle_id ON transfers (bundle_id);
      CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers (status);
      CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log (event_type);
    `);
  }

  getDb(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  async close(): Promise<void> {
    if (this.db) {
      logger.info('Closing database connection');
      this.db.close();
      this.db = null;
    }
  }

  // Helper methods for common operations
  async logAuditEvent(eventType: string, projectId?: string, peerId?: string, data?: any): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO audit_log (event_type, project_id, peer_id, data, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      eventType,
      projectId || null,
      peerId || null,
      data ? JSON.stringify(data) : null,
      new Date().toISOString()
    );
  }

  async allocatePort(projectId: string, preferredPort?: number): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    const startPort = preferredPort || 3000;
    const maxPort = 65535;

    for (let port = startPort; port <= maxPort; port++) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO port_registry (port, project_id, allocated_at)
          VALUES (?, ?, ?)
        `);
        
        stmt.run(port, projectId, new Date().toISOString());
        return port;
      } catch (error) {
        // Port already allocated, try next one
        continue;
      }
    }

    throw new Error('No available ports');
  }

  async releasePort(port: number): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('DELETE FROM port_registry WHERE port = ?');
    stmt.run(port);
  }
}
