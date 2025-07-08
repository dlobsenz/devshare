#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod crypto;
mod compression;

pub use crypto::*;
pub use compression::*;

#[napi]
pub fn sha256(data: Buffer) -> Result<Buffer> {
  crypto::sha256_hash(&data)
}

#[napi]
pub fn zstd_compress(data: Buffer) -> Result<Buffer> {
  compression::compress_data(&data)
}

#[napi]
pub fn zstd_decompress(data: Buffer) -> Result<Buffer> {
  compression::decompress_data(&data)
}

#[napi]
pub fn generate_keypair() -> Result<KeyPair> {
  crypto::generate_ed25519_keypair()
}

#[napi]
pub fn sign_data(private_key: String, data: Buffer) -> Result<String> {
  crypto::sign_with_ed25519(&private_key, &data)
}

#[napi]
pub fn verify_signature(public_key: String, signature: String, data: Buffer) -> Result<bool> {
  crypto::verify_ed25519_signature(&public_key, &signature, &data)
}

#[napi]
pub fn encrypt_aes_gcm(key: Buffer, nonce: Buffer, data: Buffer) -> Result<Buffer> {
  crypto::encrypt_aes_gcm(&key, &nonce, &data)
}

#[napi]
pub fn decrypt_aes_gcm(key: Buffer, nonce: Buffer, encrypted_data: Buffer) -> Result<Buffer> {
  crypto::decrypt_aes_gcm(&key, &nonce, &encrypted_data)
}

#[napi]
pub fn generate_random_bytes(length: u32) -> Result<Buffer> {
  crypto::generate_random_bytes(length as usize)
}

#[napi(object)]
pub struct KeyPair {
  pub public_key: String,
  pub private_key: String,
}
