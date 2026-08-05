import { encrypt, decrypt } from "../crypto";
import type { VaultConfig } from "./types";

type EncryptedBlob = {
  v: 1;
  nonceB64: string;
  ciphertextB64: string;
};

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeVaultBlob(list: VaultConfig[], key: Uint8Array): string {
  const plaintext = JSON.stringify(list);
  const { nonce, ciphertext } = encrypt(key, plaintext);
  const blob: EncryptedBlob = {
    v: 1,
    nonceB64: bytesToB64(nonce),
    ciphertextB64: bytesToB64(ciphertext),
  };
  return JSON.stringify(blob);
}

export function decodeVaultBlob(raw: string, key: Uint8Array): VaultConfig[] {
  const blob = JSON.parse(raw) as EncryptedBlob;
  const plaintext = decrypt(key, b64ToBytes(blob.nonceB64), b64ToBytes(blob.ciphertextB64));
  return JSON.parse(plaintext) as VaultConfig[];
}
