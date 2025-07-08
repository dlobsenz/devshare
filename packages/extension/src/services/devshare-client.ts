import { 
  JsonRpcRequest, 
  JsonRpcResponse, 
  Project,
  ShareParams,
  ShareResult,
  ImportParams,
  ImportResult,
  RunParams,
  RunResult,
  StopParams,
  StopResult,
  ProjectStatus,
  Peer
} from '@devshare/proto';

const WEBSOCKET_DEFAULT_PORT = 7681;

// Use built-in WebSocket for VS Code extension
declare const WebSocket: {
  new (url: string): {
    onopen: ((event: any) => void) | null;
    onclose: ((event: any) => void) | null;
    onerror: ((event: any) => void) | null;
    onmessage: ((event: any) => void) | null;
    readyState: number;
    send(data: string): void;
    close(): void;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
  };
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
};

export class DevShareClient {
  private ws: any = null;
  private requestId = 0;
  private pendingRequests = new Map<string | number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Use Node.js WebSocket for now (will be replaced with VS Code's WebSocket)
        const WS = require('ws');
        this.ws = new WS(`ws://127.0.0.1:${WEBSOCKET_DEFAULT_PORT}`);

        this.ws.on('open', () => {
          console.log('Connected to DevShare daemon');
          resolve();
        });

        this.ws.on('error', (error: any) => {
          console.error('WebSocket error:', error);
          reject(error);
        });

        this.ws.on('close', () => {
          console.log('Disconnected from DevShare daemon');
          this.ws = null;
        });

        this.ws.on('message', (data: any) => {
          try {
            const response: JsonRpcResponse = JSON.parse(data.toString());
            this.handleResponse(response);
          } catch (error) {
            console.error('Error parsing response:', error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (response.id === null || response.id === undefined) {
      return;
    }
    
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private async sendRequest(method: string, params?: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== 1) { // 1 = OPEN
      throw new Error('Not connected to daemon');
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      
      this.ws.send(JSON.stringify(request));
      
      // Set timeout for request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000); // 30 second timeout
    });
  }

  async ping(): Promise<{ pong: true; version: string; uptime: number }> {
    return this.sendRequest('ping');
  }

  async listProjects(): Promise<Project[]> {
    return this.sendRequest('listProjects');
  }

  async share(params: ShareParams): Promise<ShareResult> {
    return this.sendRequest('share', params);
  }

  async import(params: ImportParams): Promise<ImportResult> {
    return this.sendRequest('import', params);
  }

  async run(params: RunParams): Promise<RunResult> {
    return this.sendRequest('run', params);
  }

  async stop(params: StopParams): Promise<StopResult> {
    return this.sendRequest('stop', params);
  }

  async getProjectStatus(params: { projectId: string }): Promise<ProjectStatus> {
    return this.sendRequest('getProjectStatus', params);
  }

  async listPeers(): Promise<Peer[]> {
    return this.sendRequest('listPeers');
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
