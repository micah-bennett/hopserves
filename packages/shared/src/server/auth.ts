import "server-only";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { parseCookie, stringifySetCookie } from "cookie";
import bcrypt from "bcryptjs";
import { APP_FOR_ROLE, appUrlFor } from "../brand";
import type { Facility, PortalUser, Role, Unit } from "../types";
import { customerSignupSchema, forgotSchema, loginSchema, resendCodeSchema, setPasswordSchema, signupSchema, verifyCodeSchema } from "../validate";
import { json, readJson, sql, zodMessage } from "./db";
import { sendLoginCodeEmail, sendPasswordResetEmail } from "./email";

/*
 * Email + password auth for the Portal apps, plus a 6-digit code emailed at every sign-in and
 * sign-up (see "Email sign-in codes" below). Ported from the old api/_lib/hopAuth.ts
 * (git show 88ec07f:api/_lib/hopAuth.ts). One role per app; every route calls requireUser.
 * Passwords are bcrypt hashes; session, reset and code tokens are stored only as HMAC-SHA256
 * hashes keyed with SESSION_HASH_SECRET, so a database leak doesn't reveal a usable one.
 *
 * The cookie name includes the role (hop_portal_console, hop_portal_rep, ...). In production
 * each app has its own domain anyway, but on localhost cookies ignore the port, so one shared
 * name would let signing in to the Console sign you out of the Rep App.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const TOKEN_TTL_MS = { invite: 7 * 24 * 60 * 60 * 1000, reset: 30 * 60 * 1000 } as const;
const CODE_TTL_MS = 10 * 60 * 1000; // an emailed sign-in code works for 10 minutes
const CODE_MAX_ATTEMPTS = 5; // wrong guesses before the code is dead (1 in 200,000 odds)
const CODE_MAX_SENDS = 5; // sends (first + resends) per challenge
const CODE_RESEND_GAP_MS = 30 * 1000;
const CODE_MAX_PER_WINDOW = 6; // new challenges per user per 15 minutes, so the inbox can't be flooded

export const cookieName = (role: Role) => `hop_portal_${role}`;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function hashToken(token: string): string {
  const secret = process.env.SESSION_HASH_SECRET?.trim();
  if (!secret) throw new Error("SESSION_HASH_SECRET is not configured");
  return createHmac("sha256", secret).update(token).digest("hex");
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

function sessionCookie(request: Request, role: Role, token: string, maxAge: number): string {
  return stringifySetCookie({ name: cookieName(role), value: token, httpOnly: true, secure: isSecure(request), sameSite: "lax", path: "/", maxAge });
}

// ── Users ────────────────────────────────────────────────────────────────────

type UserRow = {
  id: string;
  email: string;
  role: string;
  first_name: string;
  last_name: string;
  phone: string;
  status: string;
  facility_id: string | null;
};

export function toUser(row: UserRow): PortalUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role as Role,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone || "",
    status: row.status as PortalUser["status"],
    facilityId: row.facility_id
  };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(userId: string, request: Request): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const ua = (request.headers.get("user-agent") || "").slice(0, 300);
  await sql()`INSERT INTO portal_sessions (token_hash, user_id, user_agent, expires_at) VALUES (${hashToken(token)}, ${userId}, ${ua}, ${expiresAt})`;
  return token;
}

async function userForToken(token: string | undefined | null): Promise<PortalUser | null> {
  if (!token) return null;
  const rows = (await sql()`
    SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone, u.status, u.facility_id
    FROM portal_sessions s JOIN portal_users u ON u.id = s.user_id
    WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > NOW()
  `) as UserRow[];
  const row = rows[0];
  if (!row || row.status !== "active") return null;
  return toUser(row);
}

/** The signed-in user for this app's role, from a route handler's Request. */
export async function getSessionUser(request: Request, role: Role): Promise<PortalUser | null> {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const user = await userForToken(parseCookie(header)[cookieName(role)]);
  return user && user.role === role ? user : null;
}

/** Same, for server components and layouts (reads next/headers cookies). */
export async function getSessionUserFromCookies(role: Role): Promise<PortalUser | null> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  const user = await userForToken(store.get(cookieName(role))?.value);
  return user && user.role === role ? user : null;
}

/** Returns the signed-in user with `role`, or throws a 401 Response. Use inside withAuth. */
export async function requireUser(request: Request, role: Role): Promise<PortalUser> {
  const user = await getSessionUser(request, role);
  if (!user) throw json({ error: "Not signed in" }, 401);
  return user;
}

type Handler<C> = (request: Request, user: PortalUser, ctx: C) => Promise<Response>;

/**
 * Wraps a route handler: checks the session for `role`, and turns any thrown Response
 * (from requireUser, readJson, or your own `throw json(...)`) into the reply.
 */
export function withAuth<C = unknown>(role: Role, handler: Handler<C>) {
  return async (request: Request, ctx: C): Promise<Response> => {
    try {
      const user = await requireUser(request, role);
      return await handler(request, user, ctx);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error("[api] unhandled error", e);
      return json({ error: "Something went wrong" }, 500);
    }
  };
}

// ── Password tokens (invites and resets) ─────────────────────────────────────

export async function createPasswordToken(userId: string, purpose: "invite" | "reset"): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS[purpose]).toISOString();
  await sql()`INSERT INTO portal_password_tokens (token_hash, user_id, purpose, expires_at) VALUES (${hashToken(token)}, ${userId}, ${purpose}, ${expiresAt})`;
  return token;
}

/** Marks the token used and returns its user id, or null if invalid, expired, or already used. */
export async function consumePasswordToken(token: string): Promise<string | null> {
  const rows = (await sql()`
    UPDATE portal_password_tokens SET used_at = NOW()
    WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > NOW()
    RETURNING user_id
  `) as { user_id: string }[];
  return rows[0]?.user_id ?? null;
}

// ── Email sign-in codes ──────────────────────────────────────────────────────
// A correct password (or a new sign-up) doesn't start a session. It creates a challenge: a random
// token kept by the browser, and a 6-digit code emailed to the account. The session starts only when
// both come back together (POST ?action=verify-code). Only HMAC hashes of either are stored.

const codeHash = (challenge: string, code: string) => hashToken(`login-code:${challenge}:${code}`);
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "jordan@example.com" → "jo•••@example.com", so the screen can say where the code went. */
export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}${"•".repeat(3)}@${domain}`;
}

/** Creates a challenge and emails its code. Throws a Response (429/503) the route returns as is. */
async function startLoginCode(userId: string, email: string, appName: string): Promise<string> {
  const recent = (await sql()`
    SELECT COUNT(*)::int AS n FROM portal_login_codes WHERE user_id = ${userId} AND created_at > NOW() - INTERVAL '15 minutes'
  `) as { n: number }[];
  if ((recent[0]?.n ?? 0) >= CODE_MAX_PER_WINDOW) {
    throw json({ error: "Too many sign-in codes asked for. Wait 15 minutes and try again." }, 429);
  }
  // One live code per person: asking again retires the previous one.
  await sql()`UPDATE portal_login_codes SET used_at = NOW() WHERE user_id = ${userId} AND used_at IS NULL`;
  const challenge = randomBytes(32).toString("hex");
  const code = newCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await sql()`
    INSERT INTO portal_login_codes (challenge_hash, user_id, code_hash, expires_at)
    VALUES (${hashToken(challenge)}, ${userId}, ${codeHash(challenge, code)}, ${expiresAt})
  `;
  try {
    await sendLoginCodeEmail(email, code, appName);
  } catch (e) {
    console.error("[auth] sign-in code email failed", e);
    await sql()`DELETE FROM portal_login_codes WHERE challenge_hash = ${hashToken(challenge)}`;
    throw json({ error: "We couldn't send your sign-in code. Try again in a minute." }, 503);
  }
  return challenge;
}

type CodeRow = { user_id: string; code_hash: string; attempts: number; sends: number; last_sent_at: string };

async function liveChallenge(challenge: string): Promise<CodeRow | null> {
  const rows = (await sql()`
    SELECT user_id, code_hash, attempts, sends, last_sent_at FROM portal_login_codes
    WHERE challenge_hash = ${hashToken(challenge)} AND used_at IS NULL AND expires_at > NOW()
  `) as CodeRow[];
  return rows[0] ?? null;
}

// ── Facilities (public list for the Staff sign-up form) ──────────────────────

export async function listFacilitiesWithUnits(): Promise<(Facility & { units: Unit[] })[]> {
  const fac = (await sql()`SELECT id, name, city FROM portal_facilities ORDER BY name`) as Facility[];
  const units = (await sql()`SELECT id, facility_id, name FROM portal_units ORDER BY name`) as { id: string; facility_id: string; name: string }[];
  return fac.map((f) => ({ ...f, units: units.filter((u) => u.facility_id === f.id).map((u) => ({ id: u.id, facilityId: u.facility_id, name: u.name })) }));
}

// ── /api/auth route factory ──────────────────────────────────────────────────

export type SignupInput = ReturnType<typeof signupSchema.parse>;
export type CustomerSignupInput = ReturnType<typeof customerSignupSchema.parse>;

type AuthOptions = {
  role: Role;
  /** Staff App only: allow POST ?action=signup and GET ?action=facilities. */
  allowSignup?: boolean;
  /** Runs after the user row is inserted (Staff writes its profile). Throw a Response to reject. */
  onSignup?: (userId: string, input: SignupInput) => Promise<void>;
  /** Concierge Portal only: allow POST ?action=signup for individual customers (no facility). */
  allowCustomerSignup?: boolean;
  /** Runs after a customer row is inserted (the Concierge Portal writes its profile). Throw to reject. */
  onCustomerSignup?: (userId: string, input: CustomerSignupInput) => Promise<void>;
};

const BAD_LOGIN = "That email and password don't match.";

function appUrl(): string {
  return (process.env.APP_URL || "").replace(/\/+$/, "");
}

export function createAuthRoutes(opts: AuthOptions) {
  const { role } = opts;

  const withCookie = (body: unknown, status: number, cookie: string) => json(body, status, { "Set-Cookie": cookie });

  async function signIn(request: Request, userId: string) {
    const token = await createSession(userId, request);
    await sql()`UPDATE portal_users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = ${userId}`;
    return sessionCookie(request, role, token, SESSION_TTL_MS / 1000);
  }

  async function login(request: Request): Promise<Response> {
    const parsed = loginSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: BAD_LOGIN }, 400);
    const { email, password } = parsed.data;
    const rows = (await sql()`
      SELECT id, email, role, first_name, last_name, phone, status, facility_id, password_hash, failed_login_attempts, locked_until
      FROM portal_users WHERE lower(email) = ${email}
    `) as (UserRow & { password_hash: string | null; failed_login_attempts: number; locked_until: string | null })[];
    const row = rows[0];
    if (!row || !row.password_hash) return json({ error: BAD_LOGIN }, 401);
    if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      return json({ error: "Too many failed attempts. Try again in a few minutes." }, 429);
    }
    if (!(await verifyPassword(password, row.password_hash))) {
      const next = row.failed_login_attempts + 1;
      const lockedUntil = next >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;
      await sql()`UPDATE portal_users SET failed_login_attempts = ${next}, locked_until = ${lockedUntil}, updated_at = NOW() WHERE id = ${row.id}`;
      return json({ error: BAD_LOGIN }, 401);
    }
    if (row.status !== "active") return json({ error: "This account is turned off. Contact HOP." }, 403);
    if (row.role !== role) {
      const app = APP_FOR_ROLE[row.role as Role];
      return json({ error: `This account is for the ${app.name}.`, appForRole: app.name, appUrl: appUrlFor(row.role as Role) }, 403);
    }
    return await needCode(row.id, row.email, 200);
  }

  /** The password (or sign-up) was fine; now prove the email. Nothing is signed in yet. */
  async function needCode(userId: string, email: string, status: number): Promise<Response> {
    const challenge = await startLoginCode(userId, email, APP_FOR_ROLE[role].name);
    return json({ needsCode: true, challenge, sentTo: maskEmail(email) }, status);
  }

  async function verifyCode(request: Request): Promise<Response> {
    const parsed = verifyCodeSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: zodMessage(parsed.error) }, 400);
    const { challenge, code } = parsed.data;
    const row = await liveChallenge(challenge);
    if (!row) return json({ error: "This code has expired. Sign in again to get a new one.", expired: true }, 400);
    if (!sameHash(row.code_hash, codeHash(challenge, code))) {
      const attempts = row.attempts + 1;
      const dead = attempts >= CODE_MAX_ATTEMPTS;
      await sql()`
        UPDATE portal_login_codes SET attempts = ${attempts}, used_at = ${dead ? new Date().toISOString() : null}
        WHERE challenge_hash = ${hashToken(challenge)}
      `;
      return dead
        ? json({ error: "Too many wrong codes. Sign in again to get a new one.", expired: true }, 400)
        : json({ error: "That code isn't right. Check the email and try again." }, 400);
    }
    // Single use, even if two requests race: only the one that flips used_at goes on.
    const won = (await sql()`
      UPDATE portal_login_codes SET used_at = NOW() WHERE challenge_hash = ${hashToken(challenge)} AND used_at IS NULL RETURNING user_id
    `) as { user_id: string }[];
    if (!won[0]) return json({ error: "This code has expired. Sign in again to get a new one.", expired: true }, 400);
    const users = (await sql()`
      UPDATE portal_users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW()
      WHERE id = ${row.user_id}
      RETURNING id, email, role, first_name, last_name, phone, status, facility_id
    `) as UserRow[];
    const u = users[0];
    if (!u || u.status !== "active" || u.role !== role) return json({ error: "This account can't sign in here." }, 403);
    const cookie = await signIn(request, u.id);
    return withCookie({ user: toUser(u) }, 200, cookie);
  }

  async function resendCode(request: Request): Promise<Response> {
    const parsed = resendCodeSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: zodMessage(parsed.error) }, 400);
    const { challenge } = parsed.data;
    const row = await liveChallenge(challenge);
    if (!row) return json({ error: "This code has expired. Sign in again to get a new one.", expired: true }, 400);
    if (row.sends >= CODE_MAX_SENDS) return json({ error: "That's the most codes we can send for this sign-in. Sign in again.", expired: true }, 429);
    if (Date.now() - new Date(row.last_sent_at).getTime() < CODE_RESEND_GAP_MS) {
      return json({ error: "Give it 30 seconds before asking for another code." }, 429);
    }
    const users = (await sql()`SELECT email FROM portal_users WHERE id = ${row.user_id} AND status = 'active'`) as { email: string }[];
    if (!users[0]) return json({ error: "This account can't sign in here." }, 403);
    const code = newCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    await sql()`
      UPDATE portal_login_codes
      SET code_hash = ${codeHash(challenge, code)}, attempts = 0, sends = sends + 1, last_sent_at = NOW(), expires_at = ${expiresAt}
      WHERE challenge_hash = ${hashToken(challenge)}
    `;
    try {
      await sendLoginCodeEmail(users[0].email, code, APP_FOR_ROLE[role].name);
    } catch (e) {
      console.error("[auth] sign-in code resend failed", e);
      return json({ error: "We couldn't send your sign-in code. Try again in a minute." }, 503);
    }
    return json({ ok: true, sentTo: maskEmail(users[0].email) });
  }

  async function signup(request: Request): Promise<Response> {
    const parsed = signupSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: zodMessage(parsed.error) }, 400);
    const input = parsed.data;
    const facility = (await sql()`SELECT 1 FROM portal_facilities WHERE id = ${input.facilityId}`) as unknown[];
    if (!facility.length) return json({ error: "Pick your organization from the list." }, 400);
    const exists = (await sql()`SELECT 1 FROM portal_users WHERE lower(email) = ${input.email}`) as unknown[];
    if (exists.length) return json({ error: "An account with this email already exists. Try signing in." }, 409);
    const hash = await hashPassword(input.password);
    const rows = (await sql()`
      INSERT INTO portal_users (email, password_hash, role, first_name, last_name, phone, status, facility_id)
      VALUES (${input.email}, ${hash}, ${role}, ${input.firstName}, ${input.lastName}, ${input.phone}, 'active', ${input.facilityId})
      RETURNING id, email, role, first_name, last_name, phone, status, facility_id
    `) as UserRow[];
    const user = toUser(rows[0]);
    try {
      await opts.onSignup?.(user.id, input);
    } catch (e) {
      await sql()`DELETE FROM portal_users WHERE id = ${user.id}`;
      throw e;
    }
    // Not signed in until the emailed code proves the address is theirs.
    return await needCode(user.id, user.email, 201);
  }

  async function customerSignup(request: Request): Promise<Response> {
    const parsed = customerSignupSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: zodMessage(parsed.error) }, 400);
    const input = parsed.data;
    const exists = (await sql()`SELECT 1 FROM portal_users WHERE lower(email) = ${input.email}`) as unknown[];
    if (exists.length) return json({ error: "An account with this email already exists. Try signing in." }, 409);
    const hash = await hashPassword(input.password);
    // No facility: a customer belongs to no organization, so no Facility View can ever see them.
    const rows = (await sql()`
      INSERT INTO portal_users (email, password_hash, role, first_name, last_name, phone, status, facility_id)
      VALUES (${input.email}, ${hash}, ${role}, ${input.firstName}, ${input.lastName}, ${input.phone}, 'active', NULL)
      RETURNING id, email, role, first_name, last_name, phone, status, facility_id
    `) as UserRow[];
    const user = toUser(rows[0]);
    try {
      await opts.onCustomerSignup?.(user.id, input);
    } catch (e) {
      await sql()`DELETE FROM portal_users WHERE id = ${user.id}`;
      throw e;
    }
    // Not signed in until the emailed code proves the address is theirs.
    return await needCode(user.id, user.email, 201);
  }

  async function setPassword(request: Request): Promise<Response> {
    const parsed = setPasswordSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: zodMessage(parsed.error) }, 400);
    const userId = await consumePasswordToken(parsed.data.token);
    if (!userId) return json({ error: "This link has expired or was already used. Ask HOP for a new one." }, 400);
    const hash = await hashPassword(parsed.data.password);
    const rows = (await sql()`
      UPDATE portal_users
      SET password_hash = ${hash}, status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
          email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW()
      WHERE id = ${userId}
      RETURNING id, email, role, first_name, last_name, phone, status, facility_id
    `) as UserRow[];
    const user = toUser(rows[0]);
    await sql()`DELETE FROM portal_sessions WHERE user_id = ${userId}`;
    if (user.role !== role || user.status !== "active") return json({ user, signedIn: false }, 200);
    const cookie = await signIn(request, user.id);
    return withCookie({ user, signedIn: true }, 200, cookie);
  }

  async function forgot(request: Request): Promise<Response> {
    const parsed = forgotSchema.safeParse(await readJson(request));
    if (parsed.success) {
      const rows = (await sql()`SELECT id FROM portal_users WHERE lower(email) = ${parsed.data.email} AND role = ${role} AND status = 'active'`) as { id: string }[];
      if (rows[0]) {
        const token = await createPasswordToken(rows[0].id, "reset");
        const base = appUrl() || new URL(request.url).origin;
        await sendPasswordResetEmail(parsed.data.email, `${base}/set-password?token=${token}`).catch((e) => console.error("[auth] reset email failed", e));
      }
    }
    // Same answer either way, so this can't be used to find out who has an account.
    return json({ ok: true });
  }

  async function GET(request: Request): Promise<Response> {
    try {
      const action = new URL(request.url).searchParams.get("action");
      if (action === "facilities" && opts.allowSignup) return json({ facilities: await listFacilitiesWithUnits() });
      if (action === "me") {
        const user = await getSessionUser(request, role);
        return user ? json({ user }) : json({ error: "Not signed in" }, 401);
      }
      return json({ error: "Unknown action" }, 400);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error("[auth] GET failed", e);
      return json({ error: "Something went wrong" }, 500);
    }
  }

  async function POST(request: Request): Promise<Response> {
    try {
      const action = new URL(request.url).searchParams.get("action");
      if (action === "login") return await login(request);
      if (action === "verify-code") return await verifyCode(request);
      if (action === "resend-code") return await resendCode(request);
      if (action === "logout") {
        const header = request.headers.get("cookie");
        const token = header ? parseCookie(header)[cookieName(role)] : undefined;
        if (token) await sql()`DELETE FROM portal_sessions WHERE token_hash = ${hashToken(token)}`;
        return withCookie({ ok: true }, 200, sessionCookie(request, role, "", 0));
      }
      if (action === "signup" && opts.allowSignup) return await signup(request);
      if (action === "signup" && opts.allowCustomerSignup) return await customerSignup(request);
      if (action === "set-password") return await setPassword(request);
      if (action === "forgot") return await forgot(request);
      return json({ error: "Unknown action" }, 400);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error("[auth] POST failed", e);
      return json({ error: "Something went wrong" }, 500);
    }
  }

  return { GET, POST };
}
