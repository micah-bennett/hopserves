"use client";
import { useState, type FormEvent } from "react";
import { ApiError, authApi, type CodeChallenge } from "../client";

/**
 * The second step of signing in (and of signing up): enter the 6-digit code HOP emailed.
 * `onVerified` runs once the server has started the session.
 * `onRestart` goes back to the first step when the code is dead (expired or too many tries).
 */
export function CodeStep({
  challenge,
  onVerified,
  onRestart,
  restartLabel = "Back to sign in"
}: {
  challenge: CodeChallenge;
  onVerified: () => void | Promise<void>;
  onRestart: () => void;
  restartLabel?: string;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dead, setDead] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await authApi.verifyCode(challenge.challenge, code);
      await onVerified();
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      if (err instanceof ApiError && err.body.expired) setDead(true);
    }
    setBusy(false);
  }

  async function resend() {
    setError(null);
    setNote(null);
    try {
      const r = await authApi.resendCode(challenge.challenge);
      setCode("");
      setNote(`New code sent to ${r.sentTo}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      if (err instanceof ApiError && err.body.expired) setDead(true);
    }
  }

  // Its own card and form (rendered instead of the sign-in or sign-up card), so Enter submits the code.
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="HOP" className="auth-logo" />
      <h1 className="disp">Check your email</h1>
      <p className="auth-sub">We sent a 6-digit code to {challenge.sentTo}. It expires in 10 minutes.</p>
      {!dead && (
        <label className="dl">
          <span>Code</span>
          <input
            className="field"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            style={{ letterSpacing: 6, fontSize: 20, textAlign: "center" }}
          />
        </label>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      {note && <p className="auth-sub">{note}</p>}
      {!dead && (
        <button className="btn p w" disabled={busy || code.length !== 6}>
          {busy ? "One moment…" : "Verify and continue"}
        </button>
      )}
      <div className="auth-links">
        {!dead && (
          <button type="button" onClick={resend}>
            Send a new code
          </button>
        )}
        <button type="button" onClick={onRestart}>
          {restartLabel}
        </button>
      </div>
      </form>
    </main>
  );
}
