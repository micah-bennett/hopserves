"use client";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, authApi, type CodeChallenge } from "../client";
import { CodeStep } from "./CodeStep";

/**
 * Sign-in screen shared by all the Portal apps. A correct password emails a 6-digit code (CodeStep);
 * the session starts once it's entered, then it goes to `next` (default "/").
 * A user of another role gets "This account is for the …" with a link to their app.
 * `allowRemember` shows "Keep me signed in on this device" (30 days instead of 12 hours); only the
 * HOP Client, Concierge Portal and Rep App pass it, and the server enforces the same list.
 * /login?idle=1 (from IdleGuard) explains that they were signed out for inactivity.
 */
export function LoginScreen({
  appName,
  tagline,
  signupHref,
  allowRemember = false,
  next = "/"
}: {
  appName: string;
  tagline: string;
  signupHref?: string;
  allowRemember?: boolean;
  next?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; appUrl?: string | null } | null>(null);
  const [mode, setMode] = useState<"login" | "forgot" | "sent">("login");
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const [remember, setRemember] = useState(false);
  const [idleNotice, setIdleNotice] = useState(false);
  useEffect(() => {
    setIdleNotice(new URLSearchParams(window.location.search).get("idle") === "1");
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "forgot") {
        await authApi.forgot(email);
        setMode("sent");
      } else {
        setChallenge(await authApi.login(email, password, allowRemember && remember));
        setPassword("");
      }
    } catch (err) {
      const body = err instanceof ApiError ? err.body : {};
      setError({ text: err instanceof Error ? err.message : "Something went wrong", appUrl: (body.appUrl as string | null) ?? null });
    }
    setBusy(false);
  }

  if (challenge) {
    return (
      <CodeStep
        challenge={challenge}
        onVerified={() => {
          window.location.href = next;
        }}
        onRestart={() => {
          setChallenge(null);
          setBusy(false);
        }}
      />
    );
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="HOP" className="auth-logo" />
        <h1 className="disp">{mode === "login" ? appName : "Reset your password"}</h1>
        <p className="auth-sub">{mode === "login" ? tagline : mode === "forgot" ? "We'll email you a link to choose a new one." : "If that email has an account here, a reset link is on its way."}</p>
        {idleNotice && mode === "login" && (
          <p className="auth-sub" role="status" style={{ marginTop: -6 }}>
            You were signed out after 30 minutes without activity. Sign in again to pick up where you left off.
          </p>
        )}

        {mode !== "sent" && (
          <>
            <label className="dl">
              <span>Email</span>
              <input className="field" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            {mode === "login" && (
              <label className="dl">
                <span>Password</span>
                <input className="field" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            )}
            {mode === "login" && allowRemember && (
              <label className="row" style={{ gap: 10, alignItems: "flex-start", fontSize: 13.5, color: "var(--ink)" }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ marginTop: 3 }} />
                <span>
                  Keep me signed in on this device
                  <span style={{ display: "block", fontSize: 12.5, color: "var(--muted)" }}>For 30 days. Leave this off on a shared computer.</span>
                </span>
              </label>
            )}
            {error && (
              <p className="auth-error" role="alert">
                {error.text}
                {error.appUrl && (
                  <>
                    {" "}
                    <a href={`${error.appUrl.replace(/\/+$/, "")}/login`}>Go there</a>
                  </>
                )}
              </p>
            )}
            <button className="btn p w" disabled={busy}>
              {busy ? "One moment…" : mode === "login" ? "Sign in" : "Send reset link"}
            </button>
          </>
        )}

        <div className="auth-links">
          {mode === "login" ? (
            <button type="button" onClick={() => { setMode("forgot"); setError(null); }}>
              Forgot password?
            </button>
          ) : (
            <button type="button" onClick={() => { setMode("login"); setError(null); }}>
              Back to sign in
            </button>
          )}
          {signupHref && mode === "login" && <a href={signupHref}>Create an account</a>}
        </div>
      </form>
    </main>
  );
}
