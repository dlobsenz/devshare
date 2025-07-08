import { 
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
import { MockDatabase } from '../database/mock-database';
import { ProjectScanner } from './project-scanner';
import { FileBundler } from './file-bundler';
import { BundleExtractor } from './bundle-extractor';
import { ProjectExecutor } from './project-executor';
import { CryptoService } from './crypto-service';
import { Logger } from '../utils/logger';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { readFile } from 'fs/promises';

const logger = new Logger('devshare-service');

export class DevShareService {
  private database: MockDatabase;
  private projectScanner: ProjectScanner;
  private fileBundler: FileBundler;
  private bundleExtractor: BundleExtractor;
  private projectExecutor: ProjectExecutor;
  private cryptoService: CryptoService;
  private startTime: number;

  constructor(database: MockDatabase) {
    this.database = database;
    this.projectScanner = new ProjectScanner();
    this.fileBundler = new FileBundler();
    this.bundleExtractor = new BundleExtractor();
    this.projectExecutor = new ProjectExecutor();
    this.cryptoService = new CryptoService();
    this.startTime = Date.now();
  }

  async initialize(): Promise<void> {
    logger.info('Initializing DevShare service...');
    // TODO: Initialize crypto keys, peer discovery, etc.
    logger.info('DevShare service initialized');
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down DevShare service...');
    // TODO: Stop running processes, cleanup resources
    logger.info('DevShare service shutdown complete');
  }

  async ping(): Promise<{ pong: true; version: string; uptime: number }> {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    return {
      pong: true,
      version: '0.1.0',
      uptime
    };
  }

  async listProjects(): Promise<Project[]> {
    // Return mock projects for bootstrap testing
    return this.database.getProjects();
  }

  async share(params: ShareParams): Promise<ShareResult> {
    logger.info(`Sharing project from ${params.projectPath}`);
    
    try {
      // 1. Scan project directory and generate manifest
      const manifest = await this.projectScanner.scanProject(params.projectPath);
      logger.info(`Scanned project: ${manifest.name} v${manifest.version} (${manifest.language})`);
      
      // 2. Write manifest to project directory if it doesn't exist
      await this.projectScanner.writeManifest(params.projectPath, manifest);
      
      // 3. Calculate estimated bundle size
      const estimatedSize = await this.fileBundler.calculateBundleSize(params.projectPath);
      logger.info(`Estimated bundle size: ${Math.round(estimatedSize / 1024)}KB`);
      
      // 4. Create bundle
      const bundleId = `bundle_${Date.now()}`;
      const transferId = `transfer_${Date.now()}`;
      const bundlePath = join(tmpdir(), 'devshare', `${bundleId}.bundle`);
      
      const bundleResult = await this.fileBundler.createBundle({
        projectPath: params.projectPath,
        manifest,
        outputPath: bundlePath
      });
      
      logger.info(`Bundle created: ${bundleResult.fileCount} files, ${Math.round(bundleResult.size / 1024)}KB`);
      
      // 5. Sign bundle for security
      const bundleData = await readFile(bundlePath);
      const bundleHash = this.cryptoService.generateBundleHash(bundleData);
      const signature = await this.cryptoService.signBundle(bundlePath, bundleHash);
      
      logger.info(`Bundle signed with key: ${signature.publicKey.substring(0, 8)}...`);
      
      // TODO: Implement remaining sharing logic
      // 6. Start transfer to recipients
      
      await this.database.logAuditEvent('project_shared', undefined, undefined, {
        bundleId,
        projectPath: params.projectPath,
        recipients: params.recipients,
        manifest: manifest.name,
        bundlePath: bundleResult.bundlePath,
        bundleSize: bundleResult.size,
        fileCount: bundleResult.fileCount,
        checksum: bundleResult.checksum
      });

      return {
        bundleId,
        manifest,
        transferId,
        estimatedSize: bundleResult.size
      };
      
    } catch (error) {
      logger.error(`Failed to share project: ${error}`);
      throw error;
    }
  }

  async import(params: ImportParams): Promise<ImportResult> {
    logger.info(`Importing bundle ${params.bundleId}`);
    
    try {
      // 1. Find bundle file (for demo, look in temp directory)
      const bundlePath = join(tmpdir(), 'devshare', `${params.bundleId}.bundle`);
      
      // 2. Validate bundle
      const validation = await this.bundleExtractor.validateBundle(bundlePath);
      if (!validation.valid) {
        throw new Error(`Invalid bundle: ${validation.error}`);
      }
      
      logger.info(`Bundle validated: ${validation.manifest!.name} v${validation.manifest!.version}`);
      
      // 3. Determine extraction path
      const projectId = `project_${Date.now()}`;
      const devshareDir = join(homedir(), 'DevShareProjects');
      const projectPath = params.targetPath || join(devshareDir, validation.manifest!.name);
      
      // 4. Extract bundle
      const extractionResult = await this.bundleExtractor.extractBundle({
        bundlePath,
        extractPath: projectPath,
        overwrite: false
      });
      
      logger.info(`Project extracted: ${extractionResult.fileCount} files to ${projectPath}`);
      
      // 5. Register project in database
      await this.database.logAuditEvent('project_imported', projectId, undefined, {
        bundleId: params.bundleId,
        transferId: params.transferId,
        projectPath,
        manifest: extractionResult.manifest.name,
        fileCount: extractionResult.fileCount,
        totalSize: extractionResult.totalSize
      });

      return {
        projectId,
        path: projectPath,
        manifest: extractionResult.manifest
      };
      
    } catch (error) {
      logger.error(`Failed to import bundle: ${error}`);
      throw error;
    }
  }

  async run(params: RunParams): Promise<RunResult> {
    logger.info(`Running project ${params.projectId}`);
    
    try {
      // 1. Find project path (for demo, assume it's in the path parameter)
      const projectPath = params.projectPath || join(homedir(), 'DevShareProjects', params.projectId);
      
      // 2. Load manifest
      const manifest = await this.projectScanner.scanProject(projectPath);
      logger.info(`Found project: ${manifest.name} v${manifest.version}`);
      
      // 3. Allocate port
      const port = await this.database.allocatePort(params.projectId, params.port || manifest.ports?.[0]);
      
      // 4. Execute project
      const executionResult = await this.projectExecutor.executeProject({
        projectPath,
        manifest,
        port,
        env: params.env
      });
      
      logger.info(`Project started: PID ${executionResult.pid}, Port ${executionResult.port}`);
      
      // 5. Update database
      await this.database.logAuditEvent('project_started', params.projectId, undefined, {
        port: executionResult.port,
        processId: executionResult.processId,
        pid: executionResult.pid,
        command: executionResult.command,
        projectPath
      });

      return {
        processId: executionResult.processId,
        port: executionResult.port,
        pid: executionResult.pid
      };
      
    } catch (error) {
      logger.error(`Failed to run project: ${error}`);
      throw error;
    }
  }

  async stop(params: StopParams): Promise<StopResult> {
    logger.info(`Stopping project ${params.projectId}`);
    
    // TODO: Implement project stop logic
    // 1. Find running process
    // 2. Gracefully terminate
    // 3. Release port
    // 4. Update database
    
    await this.database.logAuditEvent('project_stopped', params.projectId);

    return {
      stopped: true,
      processId: `process_${Date.now()}`
    };
  }

  async getProjectStatus(params: { projectId: string }): Promise<ProjectStatus> {
    logger.debug(`Getting status for project ${params.projectId}`);
    
    // TODO: Implement real status checking
    // 1. Query database for project info
    // 2. Check if process is still running
    // 3. Get recent logs
    
    return {
      projectId: params.projectId,
      status: 'stopped',
      logs: ['Project status check - not implemented yet']
    };
  }

  async listPeers(): Promise<Peer[]> {
    // Return mock peers for bootstrap testing
    return this.database.getPeers();
  }
}
