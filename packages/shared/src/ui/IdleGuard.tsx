"use client";
import { useEffect } from "react";

const IDLE_MS = 30 * 60 * 1000; // keep in step with IDLE_TIMEOUT_MS in server/auth.ts
const HEARTBEAT_MS = 60 * 1000;
const EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart"] as const;

/**
 * Signs the person out after 30 minutes without using the page (Console and Facility View).
 * Background polling doesn't count: only real input does. While they're active it tells the server
 * once a minute (POST /api/auth?action=active), and the server ends any session of these roles whose
 * last heartbeat is older than 30 minutes, so closing the laptop lid doesn't keep it alive either.
 */
export function IdleGuard() {
  useEffect(() => {
    let lastInput = Date.now();
    let lastBeat = 0;
    let done = false;

    const toLogin = () => {
      if (done) return;
      done = true;
      window.location.href = "/login?idle=1";
    };
    const beat = () => {
      lastBeat = Date.now();
      fetch("/api/auth?action=active", { method: "POST", cache: "no-store" })
        .then((r) => {
          if (r.status === 401) toLogin();
        })
        .catch(() => {});
    };
    const onInput = () => {
      lastInput = Date.now();
      if (Date.now() - lastBeat > HEARTBEAT_MS) beat();
    };
    const check = () => {
      if (done || Date.now() - lastInput < IDLE_MS) return;
      fetch("/api/auth?action=logout", { method: "POST", cache: "no-store" }).catch(() => {}).finally(toLogin);
    };

    beat();
    EVENTS.forEach((e) => window.addEventListener(e, onInput, { passive: true }));
    document.addEventListener("visibilitychange", check);
    const t = setInterval(check, 15 * 1000);
    return () => {
      EVENTS.forEach((e) => window.removeEventListener(e, onInput));
      document.removeEventListener("visibilitychange", check);
      clearInterval(t);
    };
  }, []);
  return null;
}
