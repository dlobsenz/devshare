#!/usr/bin/env node

import { WebSocketServer } from 'ws';
import { WEBSOCKET_DEFAULT_PORT } from '@devshare/proto';
import { JsonRpcServer } from './api/jsonrpc-server';
import { DevShareService } from './services/devshare-service';
import { MockDatabase as Database } from './database/mock-database';
import { Logger } from './utils/logger';

const logger = new Logger('main');

async function main() {
  try {
    logger.info('Starting DevShare daemon...');

    // Initialize database
    const database = new Database();
    await database.initialize();

    // Initialize core service
    const devShareService = new DevShareService(database);
    await devShareService.initialize();

    // Create JSON-RPC server
    const rpcServer = new JsonRpcServer(devShareService);

    // Create WebSocket server
    const wss = new WebSocketServer({ 
      port: WEBSOCKET_DEFAULT_PORT,
      host: '127.0.0.1'
    });

    wss.on('connection', (ws, request) => {
      const clientId = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
      logger.info(`Client connected: ${clientId}`);

      // Handle JSON-RPC messages
      ws.on('message', async (data) => {
        try {
          const message = data.toString();
          const response = await rpcServer.handleMessage(message);
          if (response) {
            ws.send(response);
          }
        } catch (error) {
          logger.error('Error handling message:', error);
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal error',
              data: error instanceof Error ? error.message : String(error)
            },
            id: null
          }));
        }
      });

      ws.on('close', () => {
        logger.info(`Client disconnected: ${clientId}`);
      });

      ws.on('error', (error) => {
        logger.error(`WebSocket error for ${clientId}:`, error);
      });

      // Send welcome message
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'welcome',
        params: {
          version: '0.1.0',
          timestamp: new Date().toISOString()
        }
      }));
    });

    wss.on('listening', () => {
      logger.info(`DevShare daemon listening on ws://127.0.0.1:${WEBSOCKET_DEFAULT_PORT}`);
    });

    wss.on('error', (error) => {
      logger.error('WebSocket server error:', error);
      process.exit(1);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      wss.close();
      await devShareService.shutdown();
      await database.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      wss.close();
      await devShareService.shutdown();
      await database.close();
      process.exit(0);
    });

    // Keep process alive
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });

  } catch (error) {
    logger.error('Failed to start daemon:', error);
    process.exit(1);
  }
}

// Start the daemon
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { main };
