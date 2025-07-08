use aes_gcm::{
  aead::{Aead, KeyInit},
  Aes256Gcm, Nonce,
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use napi::bindgen_prelude::*;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

use crate::KeyPair;

#[derive(thiserror::Error, Debug)]
pub enum CryptoError {
  #[error("Invalid key format: {0}")]
  InvalidKey(String),
  #[error("Invalid signature format: {0}")]
  InvalidSignature(String),
  #[error("Encryption failed: {0}")]
  EncryptionFailed(String),
  #[error("Decryption failed: {0}")]
  DecryptionFailed(String),
  #[error("Random generation failed: {0}")]
  RandomFailed(String),
}

impl From<CryptoError> for napi::Error {
  fn from(err: CryptoError) -> Self {
    napi::Error::new(napi::Status::GenericFailure, err.to_string())
  }
}

pub fn sha256_hash(data: &[u8]) -> Result<Buffer> {
  let mut hasher = Sha256::new();
  hasher.update(data);
  let result = hasher.finalize();
  Ok(Buffer::from(result.as_slice()))
}

pub fn generate_ed25519_keypair() -> Result<KeyPair> {
  let mut csprng = OsRng;
  let signing_key = SigningKey::generate(&mut csprng);
  let verifying_key = signing_key.verifying_key();

  let private_key = hex::encode(signing_key.to_bytes());
  let public_key = hex::encode(verifying_key.to_bytes());

  Ok(KeyPair {
    public_key,
    private_key,
  })
}

pub fn sign_with_ed25519(private_key_hex: &str, data: &[u8]) -> Result<String> {
  let private_key_bytes = hex::decode(private_key_hex)
    .map_err(|e| CryptoError::InvalidKey(format!("Invalid hex: {}", e)))?;

  if private_key_bytes.len() != 32 {
    return Err(CryptoError::InvalidKey("Private key must be 32 bytes".to_string()).into());
  }

  let mut key_array = [0u8; 32];
  key_array.copy_from_slice(&private_key_bytes);

  let signing_key = SigningKey::from_bytes(&key_array);
  let signature = signing_key.sign(data);

  Ok(hex::encode(signature.to_bytes()))
}

pub fn verify_ed25519_signature(
  public_key_hex: &str,
  signature_hex: &str,
  data: &[u8],
) -> Result<bool> {
  let public_key_bytes = hex::decode(public_key_hex)
    .map_err(|e| CryptoError::InvalidKey(format!("Invalid hex: {}", e)))?;

  let signature_bytes = hex::decode(signature_hex)
    .map_err(|e| CryptoError::InvalidSignature(format!("Invalid hex: {}", e)))?;

  if public_key_bytes.len() != 32 {
    return Err(CryptoError::InvalidKey("Public key must be 32 bytes".to_string()).into());
  }

  if signature_bytes.len() != 64 {
    return Err(CryptoError::InvalidSignature("Signature must be 64 bytes".to_string()).into());
  }

  let mut key_array = [0u8; 32];
  key_array.copy_from_slice(&public_key_bytes);

  let mut sig_array = [0u8; 64];
  sig_array.copy_from_slice(&signature_bytes);

  let verifying_key = VerifyingKey::from_bytes(&key_array)
    .map_err(|e| CryptoError::InvalidKey(format!("Invalid public key: {}", e)))?;

  let signature = Signature::from_bytes(&sig_array);

  match verifying_key.verify(data, &signature) {
    Ok(()) => Ok(true),
    Err(_) => Ok(false),
  }
}

pub fn encrypt_aes_gcm(key: &[u8], nonce: &[u8], data: &[u8]) -> Result<Buffer> {
  if key.len() != 32 {
    return Err(CryptoError::InvalidKey("AES-256 key must be 32 bytes".to_string()).into());
  }

  if nonce.len() != 12 {
    return Err(CryptoError::InvalidKey("AES-GCM nonce must be 12 bytes".to_string()).into());
  }

  let cipher = Aes256Gcm::new_from_slice(key)
    .map_err(|e| CryptoError::EncryptionFailed(format!("Failed to create cipher: {}", e)))?;

  let nonce = Nonce::from_slice(nonce);

  let ciphertext = cipher
    .encrypt(nonce, data)
    .map_err(|e| CryptoError::EncryptionFailed(format!("Encryption failed: {}", e)))?;

  Ok(Buffer::from(ciphertext))
}

pub fn decrypt_aes_gcm(key: &[u8], nonce: &[u8], encrypted_data: &[u8]) -> Result<Buffer> {
  if key.len() != 32 {
    return Err(CryptoError::InvalidKey("AES-256 key must be 32 bytes".to_string()).into());
  }

  if nonce.len() != 12 {
    return Err(CryptoError::InvalidKey("AES-GCM nonce must be 12 bytes".to_string()).into());
  }

  let cipher = Aes256Gcm::new_from_slice(key)
    .map_err(|e| CryptoError::DecryptionFailed(format!("Failed to create cipher: {}", e)))?;

  let nonce = Nonce::from_slice(nonce);

  let plaintext = cipher
    .decrypt(nonce, encrypted_data)
    .map_err(|e| CryptoError::DecryptionFailed(format!("Decryption failed: {}", e)))?;

  Ok(Buffer::from(plaintext))
}

pub fn generate_random_bytes(length: usize) -> Result<Buffer> {
  use rand::RngCore;

  let mut bytes = vec![0u8; length];
  let mut rng = OsRng;
  
  rng.fill_bytes(&mut bytes);
  
  Ok(Buffer::from(bytes))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_sha256() {
    let data = b"hello world";
    let hash = sha256_hash(data).unwrap();
    assert_eq!(hash.len(), 32);
  }

  #[test]
  fn test_keypair_generation() {
    let keypair = generate_ed25519_keypair().unwrap();
    assert_eq!(keypair.public_key.len(), 64); // 32 bytes as hex
    assert_eq!(keypair.private_key.len(), 64); // 32 bytes as hex
  }

  #[test]
  fn test_sign_and_verify() {
    let keypair = generate_ed25519_keypair().unwrap();
    let data = b"test message";
    
    let signature = sign_with_ed25519(&keypair.private_key, data).unwrap();
    let is_valid = verify_ed25519_signature(&keypair.public_key, &signature, data).unwrap();
    
    assert!(is_valid);
  }

  #[test]
  fn test_aes_encrypt_decrypt() {
    let key = generate_random_bytes(32).unwrap();
    let nonce = generate_random_bytes(12).unwrap();
    let data = b"secret message";
    
    let encrypted = encrypt_aes_gcm(&key, &nonce, data).unwrap();
    let decrypted = decrypt_aes_gcm(&key, &nonce, &encrypted).unwrap();
    
    assert_eq!(data, decrypted.as_ref());
  }
}
