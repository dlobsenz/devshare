import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { stat, access } from 'fs/promises';
import { ProjectManifest } from '@devshare/proto';
import { Logger } from '../utils/logger';

const logger = new Logger('project-executor');

export interface ExecutionOptions {
  projectPath: string;
  manifest: ProjectManifest;
  port?: number;
  env?: Record<string, string>;
}

export interface ExecutionResult {
  processId: string;
  pid: number;
  port: number;
  command: string;
  startTime: Date;
}

export interface ProcessInfo {
  processId: string;
  pid: number;
  port: number;
  command: string;
  startTime: Date;
  status: 'starting' | 'running' | 'stopped' | 'error';
  logs: string[];
}

export class ProjectExecutor {
  private runningProcesses = new Map<string, {
    process: ChildProcess;
    info: ProcessInfo;
  }>();

  async executeProject(options: ExecutionOptions): Promise<ExecutionResult> {
    logger.info(`Executing project at ${options.projectPath}`);
    
    try {
      // Validate project path
      await this.validateProjectPath(options.projectPath);
      
      // Prepare execution environment
      const { command, args, env, port } = await this.prepareExecution(options);
      
      // Start the process
      const processId = `process_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const startTime = new Date();
      
      logger.info(`Starting process: ${command} ${args.join(' ')}`);
      
      const childProcess = spawn(command, args, {
        cwd: options.projectPath,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      const processInfo: ProcessInfo = {
        processId,
        pid: childProcess.pid!,
        port,
        command: `${command} ${args.join(' ')}`,
        startTime,
        status: 'starting',
        logs: []
      };
      
      // Store process info
      this.runningProcesses.set(processId, {
        process: childProcess,
        info: processInfo
      });
      
      // Set up process monitoring
      this.setupProcessMonitoring(processId, childProcess, processInfo);
      
      logger.info(`Process started: PID ${childProcess.pid}, Port ${port}`);
      
      return {
        processId,
        pid: childProcess.pid!,
        port,
        command: processInfo.command,
        startTime
      };
      
    } catch (error) {
      logger.error(`Failed to execute project: ${error}`);
      throw error;
    }
  }

  async stopProcess(processId: string): Promise<boolean> {
    logger.info(`Stopping process ${processId}`);
    
    const processData = this.runningProcesses.get(processId);
    if (!processData) {
      logger.warn(`Process ${processId} not found`);
      return false;
    }
    
    try {
      const { process: childProcess, info } = processData;
      
      // Update status
      info.status = 'stopped';
      info.logs.push(`[${new Date().toISOString()}] Process stop requested`);
      
      // Try graceful shutdown first
      childProcess.kill('SIGTERM');
      
      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (!childProcess.killed) {
          logger.warn(`Force killing process ${processId}`);
          childProcess.kill('SIGKILL');
        }
      }, 5000);
      
      // Remove from running processes
      this.runningProcesses.delete(processId);
      
      logger.info(`Process ${processId} stopped`);
      return true;
      
    } catch (error) {
      logger.error(`Failed to stop process ${processId}: ${error}`);
      return false;
    }
  }

  getProcessInfo(processId: string): ProcessInfo | null {
    const processData = this.runningProcesses.get(processId);
    return processData ? processData.info : null;
  }

  getAllProcesses(): ProcessInfo[] {
    return Array.from(this.runningProcesses.values()).map(data => data.info);
  }

  private async validateProjectPath(projectPath: string): Promise<void> {
    try {
      const stats = await stat(projectPath);
      if (!stats.isDirectory()) {
        throw new Error('Project path is not a directory');
      }
      
      // Check if devshare.yml exists
      await access(join(projectPath, 'devshare.yml'));
      
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error('Project directory or devshare.yml not found');
      }
      throw error;
    }
  }

  private async prepareExecution(options: ExecutionOptions): Promise<{
    command: string;
    args: string[];
    env: Record<string, string>;
    port: number;
  }> {
    const { manifest } = options;
    
    // Determine port
    const port = options.port || manifest.ports?.[0] || 3000;
    
    // Parse run command
    const runCommand = manifest.run;
    const [command, ...args] = runCommand.split(' ');
    
    // Prepare environment variables
    const env: Record<string, string> = {
      NODE_ENV: 'development',
      PORT: port.toString(),
      ...options.env
    };
    
    // Add manifest-specific environment variables
    if (manifest.env) {
      manifest.env.forEach(envVar => {
        if (!env[envVar]) {
          env[envVar] = this.getDefaultEnvValue(envVar);
        }
      });
    }
    
    // Install dependencies if needed
    await this.ensureDependencies(options.projectPath, manifest);
    
    return { command, args, env, port };
  }

  private async ensureDependencies(projectPath: string, manifest: ProjectManifest): Promise<void> {
    logger.info('Checking project dependencies...');
    
    try {
      if (manifest.language === 'node') {
        // Check if node_modules exists
        try {
          await access(join(projectPath, 'node_modules'));
          logger.info('Dependencies already installed');
        } catch {
          logger.info('Installing Node.js dependencies...');
          await this.runCommand('npm', ['install'], projectPath);
        }
      } else if (manifest.language === 'python') {
        // Check for requirements.txt and install if needed
        try {
          await access(join(projectPath, 'requirements.txt'));
          logger.info('Installing Python dependencies...');
          await this.runCommand('pip', ['install', '-r', 'requirements.txt'], projectPath);
        } catch {
          logger.info('No requirements.txt found, skipping dependency installation');
        }
      }
    } catch (error) {
      logger.warn(`Dependency installation failed: ${error}`);
      // Don't throw - try to run anyway
    }
  }

  private async runCommand(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args, { cwd, stdio: 'pipe' });
      
      let output = '';
      process.stdout?.on('data', (data) => {
        output += data.toString();
      });
      
      process.stderr?.on('data', (data) => {
        output += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with code ${code}: ${output}`));
        }
      });
      
      process.on('error', reject);
    });
  }

  private setupProcessMonitoring(processId: string, childProcess: ChildProcess, info: ProcessInfo): void {
    // Monitor stdout
    childProcess.stdout?.on('data', (data) => {
      const log = `[${new Date().toISOString()}] ${data.toString().trim()}`;
      info.logs.push(log);
      
      // Keep only last 100 log lines
      if (info.logs.length > 100) {
        info.logs = info.logs.slice(-100);
      }
      
      // Check for startup indicators
      if (info.status === 'starting') {
        const output = data.toString().toLowerCase();
        if (output.includes('server') && (output.includes('running') || output.includes('listening') || output.includes('started'))) {
          info.status = 'running';
          logger.info(`Process ${processId} is now running`);
        }
      }
    });
    
    // Monitor stderr
    childProcess.stderr?.on('data', (data) => {
      const log = `[${new Date().toISOString()}] ERROR: ${data.toString().trim()}`;
      info.logs.push(log);
      
      if (info.logs.length > 100) {
        info.logs = info.logs.slice(-100);
      }
    });
    
    // Handle process exit
    childProcess.on('exit', (code, signal) => {
      info.status = code === 0 ? 'stopped' : 'error';
      info.logs.push(`[${new Date().toISOString()}] Process exited with code ${code}, signal ${signal}`);
      
      logger.info(`Process ${processId} exited: code=${code}, signal=${signal}`);
      
      // Remove from running processes after a delay
      setTimeout(() => {
        this.runningProcesses.delete(processId);
      }, 30000); // Keep info for 30 seconds after exit
    });
    
    // Handle process errors
    childProcess.on('error', (error) => {
      info.status = 'error';
      info.logs.push(`[${new Date().toISOString()}] Process error: ${error.message}`);
      
      logger.error(`Process ${processId} error: ${error}`);
    });
    
    // Mark as running after a short delay if no explicit running indicator
    setTimeout(() => {
      if (info.status === 'starting' && !childProcess.killed) {
        info.status = 'running';
        logger.info(`Process ${processId} assumed to be running`);
      }
    }, 3000);
  }

  private getDefaultEnvValue(envVar: string): string {
    const defaults: Record<string, string> = {
      NODE_ENV: 'development',
      PORT: '3000',
      HOST: '0.0.0.0',
      API_URL: 'http://localhost:8000',
      DATABASE_URL: 'sqlite://./dev.db'
    };
    
    return defaults[envVar] || '';
  }

  async cleanup(): Promise<void> {
    logger.info('Cleaning up running processes...');
    
    const processIds = Array.from(this.runningProcesses.keys());
    
    for (const processId of processIds) {
      await this.stopProcess(processId);
    }
    
    logger.info('Process cleanup completed');
  }
}
