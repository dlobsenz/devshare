// JSON-RPC 2.0 API contract for DevShare extension <-> daemon communication

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: JsonRpcError;
  id: string | number | null;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

// Core DevShare API methods
export interface DevShareAPI {
  // Health check
  ping(): Promise<{ pong: true; version: string; uptime: number }>;
  
  // Project management
  listProjects(): Promise<Project[]>;
  
  // Sharing workflow
  share(params: ShareParams): Promise<ShareResult>;
  
  // Import workflow
  import(params: ImportParams): Promise<ImportResult>;
  
  // Execution management
  run(params: RunParams): Promise<RunResult>;
  stop(params: StopParams): Promise<StopResult>;
  
  // Status queries
  getProjectStatus(params: { projectId: string }): Promise<ProjectStatus>;
  listPeers(): Promise<Peer[]>;
  
  // Transfer management
  getTransferProgress(params: { transferId: string }): Promise<TransferProgress | null>;
  cancelTransfer(params: { transferId: string }): Promise<{ cancelled: boolean }>;
  addManualPeer(params: { address: string; port: number; name?: string }): Promise<{ added: boolean }>;
  discoverPeers(): Promise<Peer[]>;
}

// Project types
export interface Project {
  id: string;
  name: string;
  version: string;
  owner: string;
  path: string;
  manifest: ProjectManifest;
  status: 'stopped' | 'running' | 'error';
  port?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectManifest {
  name: string;
  version: string;
  language: 'node' | 'python' | 'docker';
  run: string;
  engines?: {
    node?: string;
    python?: string;
  };
  ports?: number[];
  env?: string[];
  secrets?: string[];
  dependencies?: Record<string, string>;
}

// Share operation types
export interface ShareParams {
  projectPath: string;
  recipients: string[]; // peer IDs
  name?: string;
  version?: string;
}

export interface ShareResult {
  bundleId: string;
  manifest: ProjectManifest;
  transferId: string;
  estimatedSize: number;
}

// Import operation types
export interface ImportParams {
  bundleId: string;
  transferId: string;
  targetPath?: string;
}

export interface ImportResult {
  projectId: string;
  path: string;
  manifest: ProjectManifest;
}

// Execution types
export interface RunParams {
  projectId: string;
  projectPath?: string;
  env?: Record<string, string>;
  port?: number;
}

export interface RunResult {
  processId: string;
  port: number;
  pid: number;
}

export interface StopParams {
  projectId: string;
}

export interface StopResult {
  stopped: boolean;
  processId?: string;
}

export interface ProjectStatus {
  projectId: string;
  status: 'stopped' | 'running' | 'error';
  processId?: string;
  port?: number;
  pid?: number;
  uptime?: number;
  logs?: string[];
  error?: string;
}

// Peer and networking types
export interface Peer {
  id: string;
  name: string;
  publicKey: string;
  lastSeen: string;
  online: boolean;
  address?: string;
}

// Transfer and progress types
export interface TransferProgress {
  transferId: string;
  bundleId: string;
  totalChunks: number;
  completedChunks: number;
  totalBytes: number;
  transferredBytes: number;
  speed: number; // bytes per second
  eta: number; // seconds
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';
  error?: string;
}

// Event types for WebSocket notifications
export interface DevShareEvent {
  type: 'transfer_progress' | 'project_status' | 'peer_discovered' | 'peer_lost';
  data: any;
}

export interface TransferProgressEvent extends DevShareEvent {
  type: 'transfer_progress';
  data: TransferProgress;
}

export interface ProjectStatusEvent extends DevShareEvent {
  type: 'project_status';
  data: ProjectStatus;
}

export interface PeerEvent extends DevShareEvent {
  type: 'peer_discovered' | 'peer_lost';
  data: Peer;
}

// Error codes
export enum DevShareErrorCode {
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
  
  // DevShare specific errors
  PROJECT_NOT_FOUND = 1001,
  PROJECT_ALREADY_RUNNING = 1002,
  PORT_IN_USE = 1003,
  INVALID_MANIFEST = 1004,
  TRANSFER_FAILED = 1005,
  SIGNATURE_INVALID = 1006,
  PEER_NOT_AUTHORIZED = 1007,
  VAULT_LOCKED = 1008,
  RUNTIME_NOT_FOUND = 1009,
  DISK_SPACE_LOW = 1010,
}
