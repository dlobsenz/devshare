import { JsonRpcRequest, JsonRpcResponse, JsonRpcError, DevShareErrorCode } from '@devshare/proto';
import { DevShareService } from '../services/devshare-service';
import { Logger } from '../utils/logger';

const logger = new Logger('jsonrpc-server');

export class JsonRpcServer {
  private devShareService: DevShareService;

  constructor(devShareService: DevShareService) {
    this.devShareService = devShareService;
  }

  async handleMessage(message: string): Promise<string | null> {
    try {
      const request: JsonRpcRequest = JSON.parse(message);
      
      if (!this.isValidRequest(request)) {
        const errorResponse = this.createErrorResponse(
          DevShareErrorCode.INVALID_REQUEST,
          'Invalid JSON-RPC request',
          (request as any).id || null
        );
        return JSON.stringify(errorResponse);
      }

      logger.debug(`Handling method: ${request.method}`, request.params);

      const response = await this.handleMethod(request);
      return JSON.stringify(response);

    } catch (error) {
      logger.error('Error parsing JSON-RPC message:', error);
      const errorResponse = this.createErrorResponse(
        DevShareErrorCode.INVALID_REQUEST,
        'Invalid JSON',
        null
      );
      return JSON.stringify(errorResponse);
    }
  }

  private isValidRequest(request: any): request is JsonRpcRequest {
    return (
      request &&
      request.jsonrpc === '2.0' &&
      typeof request.method === 'string' &&
      (request.id === undefined || typeof request.id === 'string' || typeof request.id === 'number')
    );
  }

  private async handleMethod(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      let result: any;

      switch (request.method) {
        case 'ping':
          result = await this.devShareService.ping();
          break;

        case 'listProjects':
          result = await this.devShareService.listProjects();
          break;

        case 'share':
          if (!request.params) {
            throw new Error('Missing parameters for share method');
          }
          result = await this.devShareService.share(request.params);
          break;

        case 'import':
          if (!request.params) {
            throw new Error('Missing parameters for import method');
          }
          result = await this.devShareService.import(request.params);
          break;

        case 'run':
          if (!request.params) {
            throw new Error('Missing parameters for run method');
          }
          result = await this.devShareService.run(request.params);
          break;

        case 'stop':
          if (!request.params) {
            throw new Error('Missing parameters for stop method');
          }
          result = await this.devShareService.stop(request.params);
          break;

        case 'getProjectStatus':
          if (!request.params) {
            throw new Error('Missing parameters for getProjectStatus method');
          }
          result = await this.devShareService.getProjectStatus(request.params);
          break;

        case 'listPeers':
          result = await this.devShareService.listPeers();
          break;

        case 'getTransferProgress':
          if (!request.params) {
            throw new Error('Missing parameters for getTransferProgress method');
          }
          result = await this.devShareService.getTransferProgress(request.params);
          break;

        case 'cancelTransfer':
          if (!request.params) {
            throw new Error('Missing parameters for cancelTransfer method');
          }
          result = await this.devShareService.cancelTransfer(request.params);
          break;

        case 'addManualPeer':
          if (!request.params) {
            throw new Error('Missing parameters for addManualPeer method');
          }
          result = await this.devShareService.addManualPeer(request.params);
          break;

        case 'discoverPeers':
          result = await this.devShareService.discoverPeers();
          break;

        default:
          return this.createErrorResponse(
            DevShareErrorCode.METHOD_NOT_FOUND,
            `Method '${request.method}' not found`,
            request.id
          );
      }

      return {
        jsonrpc: '2.0',
        result,
        id: request.id
      };

    } catch (error) {
      logger.error(`Error handling method ${request.method}:`, error);
      
      // Map specific errors to error codes
      let code = DevShareErrorCode.INTERNAL_ERROR;
      let message = 'Internal error';

      if (error instanceof Error) {
        message = error.message;
        
        // Map specific error types
        if (message.includes('not found')) {
          code = DevShareErrorCode.PROJECT_NOT_FOUND;
        } else if (message.includes('already running')) {
          code = DevShareErrorCode.PROJECT_ALREADY_RUNNING;
        } else if (message.includes('port')) {
          code = DevShareErrorCode.PORT_IN_USE;
        } else if (message.includes('manifest')) {
          code = DevShareErrorCode.INVALID_MANIFEST;
        } else if (message.includes('signature')) {
          code = DevShareErrorCode.SIGNATURE_INVALID;
        } else if (message.includes('parameters')) {
          code = DevShareErrorCode.INVALID_PARAMS;
        }
      }

      return this.createErrorResponse(code, message, request.id);
    }
  }

  private createErrorResponse(code: number, message: string, id: string | number | null): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      error: {
        code,
        message,
        data: null
      },
      id
    };
  }
}
