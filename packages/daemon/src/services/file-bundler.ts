import { createReadStream, createWriteStream } from 'fs';
import { readdir, stat, mkdir } from 'fs/promises';
import { join, relative, dirname } from 'path';
import { createHash } from 'crypto';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { ProjectManifest } from '@devshare/proto';
import { Logger } from '../utils/logger';

const logger = new Logger('file-bundler');

export interface BundleOptions {
  projectPath: string;
  manifest: ProjectManifest;
  outputPath: string;
  excludePatterns?: string[];
}

export interface BundleResult {
  bundlePath: string;
  size: number;
  checksum: string;
  fileCount: number;
}

export interface BundleChunk {
  index: number;
  data: Buffer;
  checksum: string;
  size: number;
}

export class FileBundler {
  private readonly CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
  private readonly DEFAULT_EXCLUDES = [
    'node_modules',
    '.git',
    '.DS_Store',
    'dist',
    'build',
    'target',
    '*.log',
    '.env',
    '.env.local',
    'coverage',
    '.nyc_output',
    '.cache',
    'tmp',
    'temp'
  ];

  async createBundle(options: BundleOptions): Promise<BundleResult> {
    logger.info(`Creating bundle for project at ${options.projectPath}`);
    
    try {
      // Ensure output directory exists
      await mkdir(dirname(options.outputPath), { recursive: true });
      
      // Get list of files to include
      const files = await this.getProjectFiles(
        options.projectPath,
        [...this.DEFAULT_EXCLUDES, ...(options.excludePatterns || [])]
      );
      
      logger.info(`Found ${files.length} files to bundle`);
      
      // Create bundle archive
      const bundleResult = await this.createArchive(
        options.projectPath,
        files,
        options.manifest,
        options.outputPath
      );
      
      logger.info(`Bundle created: ${bundleResult.bundlePath} (${Math.round(bundleResult.size / 1024)}KB)`);
      return bundleResult;
      
    } catch (error) {
      logger.error(`Failed to create bundle: ${error}`);
      throw error;
    }
  }

  async extractBundle(bundlePath: string, extractPath: string): Promise<void> {
    logger.info(`Extracting bundle ${bundlePath} to ${extractPath}`);
    
    try {
      // Ensure extract directory exists
      await mkdir(extractPath, { recursive: true });
      
      // Use the dedicated BundleExtractor service
      const { BundleExtractor } = await import('./bundle-extractor');
      const extractor = new BundleExtractor();
      
      await extractor.extractBundle({
        bundlePath,
        extractPath,
        overwrite: false
      });
      
      logger.info(`Bundle extracted successfully to ${extractPath}`);
      
    } catch (error) {
      logger.error(`Failed to extract bundle: ${error}`);
      throw error;
    }
  }

  async createChunks(bundlePath: string): Promise<BundleChunk[]> {
    logger.info(`Creating chunks for bundle ${bundlePath}`);
    
    try {
      const chunks: BundleChunk[] = [];
      const bundleStats = await stat(bundlePath);
      const totalSize = bundleStats.size;
      const numChunks = Math.ceil(totalSize / this.CHUNK_SIZE);
      
      const readStream = createReadStream(bundlePath);
      let chunkIndex = 0;
      let buffer = Buffer.alloc(0);
      
      for await (const chunk of readStream) {
        buffer = Buffer.concat([buffer, chunk]);
        
        while (buffer.length >= this.CHUNK_SIZE || (chunkIndex === numChunks - 1 && buffer.length > 0)) {
          const chunkData = buffer.subarray(0, Math.min(this.CHUNK_SIZE, buffer.length));
          buffer = buffer.subarray(chunkData.length);
          
          const checksum = createHash('sha256').update(chunkData).digest('hex');
          
          chunks.push({
            index: chunkIndex,
            data: chunkData,
            checksum,
            size: chunkData.length
          });
          
          chunkIndex++;
          
          if (chunkIndex >= numChunks) break;
        }
      }
      
      logger.info(`Created ${chunks.length} chunks`);
      return chunks;
      
    } catch (error) {
      logger.error(`Failed to create chunks: ${error}`);
      throw error;
    }
  }

  private async getProjectFiles(projectPath: string, excludePatterns: string[]): Promise<string[]> {
    const files: string[] = [];
    
    const scanDirectory = async (dirPath: string): Promise<void> => {
      const entries = await readdir(dirPath);
      
      for (const entry of entries) {
        const fullPath = join(dirPath, entry);
        const relativePath = relative(projectPath, fullPath);
        
        // Check if file should be excluded
        if (this.shouldExclude(relativePath, excludePatterns)) {
          continue;
        }
        
        const stats = await stat(fullPath);
        
        if (stats.isDirectory()) {
          await scanDirectory(fullPath);
        } else if (stats.isFile()) {
          files.push(relativePath);
        }
      }
    };
    
    await scanDirectory(projectPath);
    return files.sort();
  }

  private shouldExclude(filePath: string, excludePatterns: string[]): boolean {
    for (const pattern of excludePatterns) {
      if (pattern.includes('*')) {
        // Simple glob pattern matching
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        if (regex.test(filePath)) {
          return true;
        }
      } else {
        // Exact match or directory match
        if (filePath === pattern || filePath.startsWith(pattern + '/')) {
          return true;
        }
      }
    }
    return false;
  }

  private async createArchive(
    projectPath: string,
    files: string[],
    manifest: ProjectManifest,
    outputPath: string
  ): Promise<BundleResult> {
    // Create a simple archive format:
    // 1. Manifest (JSON)
    // 2. File count
    // 3. For each file: path length, path, content length, content
    
    const writeStream = createWriteStream(outputPath);
    const gzipStream = createGzip();
    const hash = createHash('sha256');
    
    let totalSize = 0;
    
    // Write manifest
    const manifestJson = JSON.stringify(manifest);
    const manifestBuffer = Buffer.from(manifestJson, 'utf-8');
    const manifestLengthBuffer = Buffer.alloc(4);
    manifestLengthBuffer.writeUInt32BE(manifestBuffer.length, 0);
    
    await this.writeToStream(gzipStream, manifestLengthBuffer);
    await this.writeToStream(gzipStream, manifestBuffer);
    
    // Write file count
    const fileCountBuffer = Buffer.alloc(4);
    fileCountBuffer.writeUInt32BE(files.length, 0);
    await this.writeToStream(gzipStream, fileCountBuffer);
    
    // Write files
    for (const filePath of files) {
      const fullPath = join(projectPath, filePath);
      const fileStats = await stat(fullPath);
      
      // Write file path
      const pathBuffer = Buffer.from(filePath, 'utf-8');
      const pathLengthBuffer = Buffer.alloc(4);
      pathLengthBuffer.writeUInt32BE(pathBuffer.length, 0);
      
      await this.writeToStream(gzipStream, pathLengthBuffer);
      await this.writeToStream(gzipStream, pathBuffer);
      
      // Write file size
      const fileSizeBuffer = Buffer.alloc(8);
      fileSizeBuffer.writeBigUInt64BE(BigInt(fileStats.size), 0);
      await this.writeToStream(gzipStream, fileSizeBuffer);
      
      // Write file content
      const fileStream = createReadStream(fullPath);
      for await (const chunk of fileStream) {
        await this.writeToStream(gzipStream, chunk);
      }
      
      totalSize += fileStats.size;
    }
    
    // Finalize compression and get final size
    gzipStream.end();
    
    await pipeline(gzipStream, hash, writeStream);
    
    const finalStats = await stat(outputPath);
    const checksum = hash.digest('hex');
    
    return {
      bundlePath: outputPath,
      size: finalStats.size,
      checksum,
      fileCount: files.length
    };
  }

  private async writeToStream(stream: NodeJS.WritableStream, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      stream.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  calculateBundleSize(projectPath: string, excludePatterns?: string[]): Promise<number> {
    // Quick size estimation without creating the actual bundle
    return this.getProjectFiles(
      projectPath,
      [...this.DEFAULT_EXCLUDES, ...(excludePatterns || [])]
    ).then(async (files) => {
      let totalSize = 0;
      for (const filePath of files) {
        const fullPath = join(projectPath, filePath);
        const stats = await stat(fullPath);
        totalSize += stats.size;
      }
      // Estimate compression ratio (typically 60-70% for source code)
      return Math.round(totalSize * 0.65);
    });
  }
}
