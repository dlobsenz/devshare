import { readdir, readFile, stat } from 'fs/promises';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { ProjectManifest } from '@devshare/proto';
import { Logger } from '../utils/logger';

const logger = new Logger('project-scanner');

export class ProjectScanner {
  async scanProject(projectPath: string): Promise<ProjectManifest> {
    logger.info(`Scanning project at ${projectPath}`);
    
    try {
      const stats = await stat(projectPath);
      if (!stats.isDirectory()) {
        throw new Error('Project path must be a directory');
      }

      const files = await readdir(projectPath);
      const projectName = basename(projectPath);
      
      // Check for existing devshare.yml
      if (files.includes('devshare.yml')) {
        return await this.loadExistingManifest(join(projectPath, 'devshare.yml'));
      }

      // Auto-detect project type and generate manifest
      return await this.generateManifest(projectPath, files, projectName);
      
    } catch (error) {
      logger.error(`Failed to scan project: ${error}`);
      throw error;
    }
  }

  private async loadExistingManifest(manifestPath: string): Promise<ProjectManifest> {
    try {
      const content = await readFile(manifestPath, 'utf-8');
      const manifest = parseYaml(content) as ProjectManifest;
      
      // Validate required fields
      if (!manifest.name || !manifest.version || !manifest.language || !manifest.run) {
        throw new Error('Invalid manifest: missing required fields');
      }
      
      logger.info(`Loaded existing manifest: ${manifest.name} v${manifest.version}`);
      return manifest;
      
    } catch (error) {
      logger.error(`Failed to load manifest: ${error}`);
      throw new Error(`Invalid devshare.yml: ${error}`);
    }
  }

  private async generateManifest(
    projectPath: string, 
    files: string[], 
    projectName: string
  ): Promise<ProjectManifest> {
    logger.info('Auto-detecting project type...');

    // Detect Node.js project
    if (files.includes('package.json')) {
      return await this.generateNodeManifest(projectPath, files, projectName);
    }

    // Detect Python project
    if (files.includes('requirements.txt') || files.includes('pyproject.toml') || files.includes('setup.py')) {
      return await this.generatePythonManifest(projectPath, files, projectName);
    }

    // Detect Docker project
    if (files.includes('Dockerfile')) {
      return await this.generateDockerManifest(projectPath, files, projectName);
    }

    // Default fallback
    logger.warn('Could not detect project type, using generic manifest');
    return {
      name: projectName,
      version: '1.0.0',
      language: 'node',
      run: 'npm start',
      ports: [3000]
    };
  }

  private async generateNodeManifest(
    projectPath: string, 
    files: string[], 
    projectName: string
  ): Promise<ProjectManifest> {
    try {
      const packageJsonPath = join(projectPath, 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
      
      const manifest: ProjectManifest = {
        name: packageJson.name || projectName,
        version: packageJson.version || '1.0.0',
        language: 'node',
        run: this.detectNodeRunCommand(packageJson, files),
        engines: {
          node: packageJson.engines?.node || '>=18.0.0'
        },
        ports: this.detectPorts(packageJson),
        dependencies: packageJson.dependencies || {},
        env: this.detectEnvVars(files),
        secrets: this.detectSecrets(files)
      };

      logger.info(`Generated Node.js manifest for ${manifest.name}`);
      return manifest;
      
    } catch (error) {
      logger.error(`Failed to generate Node.js manifest: ${error}`);
      throw error;
    }
  }

  private async generatePythonManifest(
    projectPath: string, 
    files: string[], 
    projectName: string
  ): Promise<ProjectManifest> {
    const manifest: ProjectManifest = {
      name: projectName,
      version: '1.0.0',
      language: 'python',
      run: this.detectPythonRunCommand(files),
      engines: {
        python: '>=3.8'
      },
      ports: [8000],
      env: this.detectEnvVars(files),
      secrets: this.detectSecrets(files)
    };

    logger.info(`Generated Python manifest for ${manifest.name}`);
    return manifest;
  }

  private async generateDockerManifest(
    projectPath: string, 
    files: string[], 
    projectName: string
  ): Promise<ProjectManifest> {
    const manifest: ProjectManifest = {
      name: projectName,
      version: '1.0.0',
      language: 'docker',
      run: 'docker-compose up',
      ports: [3000, 8000],
      env: this.detectEnvVars(files),
      secrets: this.detectSecrets(files)
    };

    logger.info(`Generated Docker manifest for ${manifest.name}`);
    return manifest;
  }

  private detectNodeRunCommand(packageJson: any, files: string[]): string {
    // Check package.json scripts
    if (packageJson.scripts) {
      if (packageJson.scripts.dev) return 'npm run dev';
      if (packageJson.scripts.start) return 'npm start';
      if (packageJson.scripts.serve) return 'npm run serve';
    }

    // Check for common frameworks
    if (files.includes('next.config.js') || files.includes('next.config.ts')) {
      return 'npm run dev';
    }
    if (files.includes('vite.config.js') || files.includes('vite.config.ts')) {
      return 'npm run dev';
    }
    if (files.includes('angular.json')) {
      return 'ng serve';
    }

    return 'npm start';
  }

  private detectPythonRunCommand(files: string[]): string {
    if (files.includes('manage.py')) {
      return 'python manage.py runserver';
    }
    if (files.includes('app.py')) {
      return 'python app.py';
    }
    if (files.includes('main.py')) {
      return 'python main.py';
    }
    if (files.includes('server.py')) {
      return 'python server.py';
    }
    
    return 'python main.py';
  }

  private detectPorts(packageJson: any): number[] {
    const ports: number[] = [];
    
    // Check common port configurations
    if (packageJson.config?.port) {
      ports.push(packageJson.config.port);
    }
    
    // Default ports for common frameworks
    const scripts = packageJson.scripts || {};
    const scriptString = JSON.stringify(scripts);
    
    if (scriptString.includes('next')) ports.push(3000);
    if (scriptString.includes('vite')) ports.push(5173);
    if (scriptString.includes('react-scripts')) ports.push(3000);
    if (scriptString.includes('vue-cli')) ports.push(8080);
    if (scriptString.includes('angular')) ports.push(4200);
    
    return ports.length > 0 ? ports : [3000];
  }

  private detectEnvVars(files: string[]): string[] {
    const envVars: string[] = [];
    
    if (files.includes('.env.example')) {
      envVars.push('NODE_ENV', 'PORT');
    }
    if (files.includes('.env.template')) {
      envVars.push('NODE_ENV', 'PORT');
    }
    
    return envVars;
  }

  private detectSecrets(files: string[]): string[] {
    const secrets: string[] = [];
    
    if (files.includes('.env.example') || files.includes('.env.template')) {
      secrets.push('API_KEY', 'DATABASE_URL', 'JWT_SECRET');
    }
    
    return secrets;
  }

  async writeManifest(projectPath: string, manifest: ProjectManifest): Promise<void> {
    const manifestPath = join(projectPath, 'devshare.yml');
    const yamlContent = this.manifestToYaml(manifest);
    
    try {
      await readFile(manifestPath, 'utf-8');
      logger.warn('devshare.yml already exists, skipping write');
      return;
    } catch {
      // File doesn't exist, proceed with writing
    }
    
    const { writeFile } = await import('fs/promises');
    await writeFile(manifestPath, yamlContent, 'utf-8');
    logger.info(`Created devshare.yml at ${manifestPath}`);
  }

  private manifestToYaml(manifest: ProjectManifest): string {
    const lines: string[] = [];
    
    lines.push(`name: ${manifest.name}`);
    lines.push(`version: ${manifest.version}`);
    lines.push(`language: ${manifest.language}`);
    lines.push(`run: ${manifest.run}`);
    
    if (manifest.engines) {
      lines.push('engines:');
      if (manifest.engines.node) lines.push(`  node: "${manifest.engines.node}"`);
      if (manifest.engines.python) lines.push(`  python: "${manifest.engines.python}"`);
    }
    
    if (manifest.ports && manifest.ports.length > 0) {
      lines.push('ports:');
      manifest.ports.forEach(port => lines.push(`  - ${port}`));
    }
    
    if (manifest.env && manifest.env.length > 0) {
      lines.push('env:');
      manifest.env.forEach(env => lines.push(`  - ${env}`));
    }
    
    if (manifest.secrets && manifest.secrets.length > 0) {
      lines.push('secrets:');
      manifest.secrets.forEach(secret => lines.push(`  - ${secret}`));
    }
    
    return lines.join('\n') + '\n';
  }
}
