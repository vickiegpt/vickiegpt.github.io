import { CAPABILITY_TTL_MS } from "./policy.js";

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid capability");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid capability");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("Invalid signing key");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createCapability({ secret, sessionId, now }) {
  if (!UUID.test(sessionId) || !Number.isFinite(now)) {
    throw new Error("Invalid capability claims");
  }
  const key = await hmacKey(secret);
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    v: 2,
    sid: sessionId,
    iat: issuedAt,
    exp: issuedAt + Math.floor(CAPABILITY_TTL_MS / 1000),
  };
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const signedValue = `v2.${encodedPayload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(signedValue)),
  );
  return `${signedValue}.${encodeBase64Url(signature)}`;
}

export async function verifyCapability(token, { secret, now }) {
  if (typeof token !== "string" || token.length > 4096) {
    throw new Error("Invalid capability");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v2") {
    throw new Error("Invalid capability");
  }

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error("Invalid capability");

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  } catch {
    throw new Error("Invalid capability");
  }
  const current = Math.floor(now / 1000);
  if (
    claims?.v !== 2 ||
    !UUID.test(claims.sid) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.exp - claims.iat !== Math.floor(CAPABILITY_TTL_MS / 1000) ||
    claims.iat > current + 30
  ) {
    throw new Error("Invalid capability");
  }
  if (claims.exp < current) throw new Error("Expired capability");
  return claims;
}
