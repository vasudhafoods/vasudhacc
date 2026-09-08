import type { AuthenticatedUser } from "@/types/auth";
import { isDashboardRole } from "@/types/auth";

const encoder = new TextEncoder();

export const DASHBOARD_SESSION_COOKIE = "vasudha_dashboard_session";
export const DASHBOARD_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

export interface DashboardSession extends AuthenticatedUser {
  expiresAt: number;
}

function base64UrlEncode(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

async function signature(payload: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function isSessionConfigurationValid(): boolean {
  return sessionSecret() !== null;
}

export async function createDashboardSession(user: AuthenticatedUser): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  const session: DashboardSession = {
    ...user,
    expiresAt: Math.floor(Date.now() / 1000) + DASHBOARD_SESSION_MAX_AGE_SECONDS,
  };
  const payload = base64UrlEncode(JSON.stringify(session));
  return `${payload}.${base64UrlEncode(await signature(payload, secret))}`;
}

export async function readDashboardSession(token: string | undefined): Promise<DashboardSession | null> {
  const secret = sessionSecret();
  if (!token || !secret) return null;
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) return null;

  try {
    const expectedSignature = await signature(payload, secret);
    if (!constantTimeEqual(base64UrlDecode(suppliedSignature), expectedSignature)) return null;
    const session = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as Partial<DashboardSession>;
    if (
      (session.userId !== null && typeof session.userId !== "string")
      || typeof session.username !== "string"
      || typeof session.displayName !== "string"
      || !isDashboardRole(session.role)
      || typeof session.expiresAt !== "number"
    ) return null;
    if (session.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return {
      userId: session.userId ?? null,
      username: session.username,
      displayName: session.displayName,
      role: session.role,
      expiresAt: session.expiresAt,
    };
  } catch {
    return null;
  }
}
