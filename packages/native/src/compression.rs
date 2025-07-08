use napi::bindgen_prelude::*;
use std::io::{Read, Write};

#[derive(thiserror::Error, Debug)]
pub enum CompressionError {
  #[error("Compression failed: {0}")]
  CompressionFailed(String),
  #[error("Decompression failed: {0}")]
  DecompressionFailed(String),
  #[error("IO error: {0}")]
  IoError(String),
}

impl From<CompressionError> for napi::Error {
  fn from(err: CompressionError) -> Self {
    napi::Error::new(napi::Status::GenericFailure, err.to_string())
  }
}

impl From<std::io::Error> for CompressionError {
  fn from(err: std::io::Error) -> Self {
    CompressionError::IoError(err.to_string())
  }
}

pub fn compress_data(data: &[u8]) -> Result<Buffer> {
  let mut encoder = zstd::Encoder::new(Vec::new(), 3)
    .map_err(|e| CompressionError::CompressionFailed(format!("Failed to create encoder: {}", e)))?;
  
  encoder.write_all(data)
    .map_err(|e| CompressionError::CompressionFailed(format!("Failed to write data: {}", e)))?;
  
  let compressed = encoder.finish()
    .map_err(|e| CompressionError::CompressionFailed(format!("Failed to finish compression: {}", e)))?;
  
  Ok(Buffer::from(compressed))
}

pub fn decompress_data(compressed_data: &[u8]) -> Result<Buffer> {
  let mut decoder = zstd::Decoder::new(compressed_data)
    .map_err(|e| CompressionError::DecompressionFailed(format!("Failed to create decoder: {}", e)))?;
  
  let mut decompressed = Vec::new();
  decoder.read_to_end(&mut decompressed)
    .map_err(|e| CompressionError::DecompressionFailed(format!("Failed to decompress: {}", e)))?;
  
  Ok(Buffer::from(decompressed))
}

pub fn get_compression_ratio(original_size: usize, compressed_size: usize) -> f64 {
  if original_size == 0 {
    return 0.0;
  }
  (original_size as f64) / (compressed_size as f64)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_compress_decompress() {
    let original_data = b"Hello, world! This is a test string that should compress well because it has repeated patterns. Hello, world! This is a test string that should compress well because it has repeated patterns.";
    
    let compressed = compress_data(original_data).unwrap();
    let decompressed = decompress_data(&compressed).unwrap();
    
    assert_eq!(original_data, decompressed.as_ref());
    assert!(compressed.len() < original_data.len());
  }

  #[test]
  fn test_compression_ratio() {
    let ratio = get_compression_ratio(1000, 500);
    assert_eq!(ratio, 2.0);
  }

  #[test]
  fn test_empty_data() {
    let empty_data = b"";
    let compressed = compress_data(empty_data).unwrap();
    let decompressed = decompress_data(&compressed).unwrap();
    
    assert_eq!(empty_data, decompressed.as_ref());
  }

  #[test]
  fn test_small_data() {
    let small_data = b"x";
    let compressed = compress_data(small_data).unwrap();
    let decompressed = decompress_data(&compressed).unwrap();
    
    assert_eq!(small_data, decompressed.as_ref());
  }
}
