import "server-only";
import { Resend } from "resend";
import { REQUEST_SOURCE_LABEL, appUrlFor, conciergeSummary } from "../brand";
import type { StaffRequest } from "../types";

const FROM = "HOP <requests@hopserves.com>";
/** HOP's team inbox: every notification goes here, and replies to HOP emails land here. */
export const HOP_INBOX = "info@hopserves.com";
const REPLY_TO = HOP_INBOX;
/** Where new-request notifications go. NOTIFY_EMAIL overrides it (same setting as the public site). */
const notifyTo = () => process.env.NOTIFY_EMAIL?.trim() || HOP_INBOX;
// Automated security mail (sign-in codes, password resets): nobody reads replies, so no reply-to and a no-reply sender.
const NO_REPLY_FROM = "HOP <no-reply@hopserves.com>";
const NOT_MONITORED = `<p style="font-size:12px;color:#5d6b82;margin:18px 0 0">This email is not monitored. Please don't reply.</p>`;

/** "HOP Client" stays as is; "Concierge Portal" becomes "HOP Concierge Portal" (no "HOP HOP Client"). */
const hopName = (appName: string) => (/^HOP\b/.test(appName) ? appName : `HOP ${appName}`);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function layout(title: string, body: string, cta?: { label: string; href: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#f7f4ee;font-family:'DM Sans',Arial,sans-serif;color:#14213a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e4e8ef;border-radius:20px;padding:28px">
<tr><td style="font-family:Montserrat,Arial,sans-serif;font-weight:800;font-size:20px;color:#012f6c;padding-bottom:12px">${esc(title)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#14213a">${body}</td></tr>
${cta ? `<tr><td style="padding:22px 0 8px"><a href="${esc(cta.href)}" style="display:inline-block;background:#04a6a8;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:14px">${esc(cta.label)}</a></td></tr>
<tr><td style="font-size:12px;color:#5d6b82;padding-top:10px">If the button doesn't work, paste this link into your browser:<br>${esc(cta.href)}</td></tr>` : ""}
</table>
<p style="font-size:12px;color:#5d6b82;margin-top:16px">HOP · Radical Hospitality for the people who keep healthcare running.</p>
</td></tr></table></body></html>`;
}

async function send(to: string, subject: string, html: string, devNote: string, opts: { noReply?: boolean; replyTo?: string } = {}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[email:dev] RESEND_API_KEY not set. Would send "${subject}" to ${to}. ${devNote}`);
      return;
    }
    throw new Error("RESEND_API_KEY is not configured");
  }
  const { error } = await new Resend(apiKey).emails.send(
    opts.noReply ? { from: NO_REPLY_FROM, to, subject, html } : { from: FROM, to, replyTo: opts.replyTo || REPLY_TO, subject, html }
  );
  if (error) throw new Error(`Email failed: ${error.message}`);
}

export async function sendInviteEmail(to: string, firstName: string, appName: string, link: string): Promise<void> {
  const body = `Hi ${esc(firstName)},<br><br>You've been added to the ${esc(hopName(appName))}. Set your password to sign in. This link works once and expires in 7 days.`;
  await send(to, `You're invited to the ${hopName(appName)}`, layout(`Welcome to HOP`, body, { label: "Set your password", href: link }), `Link: ${link}`);
}

export async function sendPasswordResetEmail(to: string, link: string): Promise<void> {
  const body = `Someone asked to reset the password for this HOP account. If that was you, choose a new password below. The link expires in 30 minutes. If it wasn't you, you can ignore this email.${NOT_MONITORED}`;
  await send(to, "Reset your HOP password", layout("Reset your password", body, { label: "Choose a new password", href: link }), `Link: ${link}`, { noReply: true });
}

/** The 6-digit sign-in code. No link on purpose: the code only works in the browser that asked for it. */
export async function sendLoginCodeEmail(to: string, code: string, appName: string): Promise<void> {
  const big = `<div style="font-family:Montserrat,Arial,sans-serif;font-weight:800;font-size:32px;letter-spacing:8px;color:#012f6c;padding:14px 0">${esc(code)}</div>`;
  const body = `Enter this code to sign in to the ${esc(hopName(appName))}:${big}It expires in 10 minutes. HOP will never ask you for this code by phone or text. If you didn't try to sign in, someone may know your password: reset it from the sign-in page.${NOT_MONITORED}`;
  await send(to, `${code} is your HOP sign-in code`, layout("Your sign-in code", body), `Code: ${code}`, { noReply: true });
}

/**
 * Tells HOP's inbox a request just came in from a Portal app (HOP Client, Concierge Portal, Rep App
 * safety alerts, Facility View unit support, reward redemptions). The public site's instant requests
 * email from apps/site instead. Never includes payment details; replies go to the customer when we
 * have their email.
 */
export async function sendNewRequestEmail(r: StaffRequest): Promise<void> {
  const source = r.source ? REQUEST_SOURCE_LABEL[r.source] ?? r.source : "Request";
  const rows: [string, string][] = [
    ["From", [r.member, r.role].filter(Boolean).join(" · ")],
    ["Came from", source],
    ["Request", r.text]
  ];
  if (r.urgent) rows.push(["Urgent", "Yes"]);
  if (r.window) rows.push(["When", r.window]);
  if (r.details) rows.push(...conciergeSummary(r.details, { contact: true }));
  const table = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#5d6b82;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`)
    .join("");
  const consoleUrl = appUrlFor("console");
  const html = layout(
    r.urgent || r.source === "safety" ? `Urgent: new ${source.toLowerCase()} request` : `New ${source} request`,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">${table}</table>`,
    consoleUrl ? { label: "Open the Concierge Console", href: consoleUrl } : undefined
  );
  const subject = `${r.urgent || r.source === "safety" ? "Urgent · " : ""}New ${source} request · ${r.member}`;
  await send(notifyTo(), subject, html, `Request ${r.id}`, { replyTo: r.details?.contact?.email || undefined });
}
