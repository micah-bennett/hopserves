# HOP Portal: architecture

How the five Portal apps are wired. This is the **design every phase builds toward**. What is
actually built today is tracked in `docs/portal/mvp-scope.md` (and in the status table of
`docs/rebuild/README.md`). If code and this doc disagree, the code wins: fix this doc in the
same change.

## Repo layout

```
apps/
  site/        Vite landing site (not part of the Portal; links to it from /portal)
  staff/       Next.js: HOP Client                role: staff
  console/     Next.js: Concierge Console         role: console
  rep/         Next.js: Concierge Rep App         role: rep
  facility/    Next.js: Facility View             role: facility_admin
  concierge/   Next.js: Concierge Portal          role: customer   (v2.1: individual customers)
packages/
  shared/      @hop/shared: everything two or more apps need
db/schema.sql  one idempotent schema for the shared Neon database
scripts/       repo-level Node scripts (create the first console account, seed and remove demo data)
prototype/     leadership's concept: starter code + mockups. Reference only, never imported
```

Each Portal app is a standard Next.js App Router project:

```
apps/<app>/
  app/layout.tsx            fonts + "@hop/shared/styles/portal.css"; <body class="phone-app"> (Staff, Rep) or "desk-app" (Console, Facility)
  app/login/page.tsx        <LoginScreen appName tagline [signupHref] /> (redirects to / if already signed in)
  app/set-password/page.tsx <SetPasswordScreen /> (invite + reset links land here)
  app/(app)/layout.tsx      requirePageUser(APP_ROLE) → redirect("/login") if absent or wrong role
  app/(app)/page.tsx        the app itself (client component ported from the starter)
  app/api/auth/route.ts     export const { GET, POST } = createAuthRoutes({ role: APP_ROLE, ... })
  app/api/<resource>/...    route handlers wrapped in withAuth(APP_ROLE, handler)
  lib/app.ts                APP_ROLE, APP_NAME, APP_TAGLINE
  public/logo.png           a committed copy of packages/shared/assets/logo.png
  next.config.ts            transpilePackages: ["@hop/shared"], the starter's security headers
  package.json              name "@hop/<app>", fixed dev port (see below)
```

Dev ports: site 5173, staff 3001, console 3002, rep 3003, facility 3004, concierge 3005.

## packages/shared (`@hop/shared`)

Source-only TypeScript with no build step. The apps compile it via `transpilePackages`.
Subpath exports:

| Import | Contents | Ported from |
|---|---|---|
| `@hop/shared/brand` | brand tokens, `JOB_TYPES`, `STATUS_LABEL`. **No hard-coded `REPS`**: reps come from the DB | `prototype/starter/lib/brand.ts` |
| `@hop/shared/types` | `Job`, `StaffRequest`, `PortalUser`, `Role`, facility/unit types | `lib/types.ts` |
| `@hop/shared/validate` | zod schemas for every API body | `lib/validate.ts` |
| `@hop/shared/client` | `j()` fetch helper + `ApiError`, `authApi`, `jobsApi`, `useJobs` polling hook (4 s, optimistic `update`, `onData` for side data) | `lib/client.ts` |
| `@hop/shared/time` | `nowT`, `nowTA` | `lib/time.ts` |
| `@hop/shared/ui/*` | `Phone` (screen shell: tabs, sheet, toast, `usePhone`, `ICONS`, `useDesktopToast`; no decorative frame), `AppHeader` (+ `SignOutButton`), `StatusSteps` (+ `statusPill`), `SignaturePad`, `LoginScreen`, `SetPasswordScreen` | `components/ui/*` |
| `@hop/shared/styles/portal.css` | the Portal design tokens + classes | `app/globals.css` |
| `@hop/shared/server/db` | `sql()` (cached `neon(DATABASE_URL)`), `json()`, `readJson()` (size-capped), `zodMessage()` | new |
| `@hop/shared/server/auth` | sessions, passwords, `requireUser`, `withAuth`, `getSessionUser`, `getSessionUserFromCookies`, password tokens, `createAuthRoutes` | old `api/_lib/hopAuth.ts` (in git history) |
| `@hop/shared/server/session` | `requirePageUser(role)` for server layouts/pages | new |
| `@hop/shared/server/store` | jobs (ownership-checked via `repId`), job/door events, requests (`listMyRequests` joins job status), users/reps/invites, facilities/units | `lib/store/postgres.ts` |
| `@hop/shared/server/email` | Resend: invite, password reset | new |
| `@hop/shared/server/integrations/*` | Twilio, Seam, push stubs with `TODO(IT)` | `lib/integrations/*` |

Server-only modules start with `import "server-only"` so they can never end up in a client
bundle.

## Accounts and auth

- **Roles**: `staff`, `rep`, `console`, `facility_admin`, `customer`. One role per user, and one
  app per role. A rep who signs in on the Console gets "This account is for the Rep App" with a link to
  it, not a session.
- **One email, one account** (unique index `portal_users_email_key`). The same person can't
  have a HOP Client account and a Concierge Portal account under one email; they use a second
  address. Sign-up on either self sign-up app checks this first: if the email belongs to the
  *other* self sign-up app it says "This email is already used for the HOP Client / Concierge
  Portal. Sign in there, or use a different email here." with a link; if it belongs to a team
  account (rep, console, facility admin) the reply is generic, so sign-up can't be used to find
  HOP's team. (Option kept open: one account per role per email, which needs the unique index
  swapped. [CONFIRM] with leadership whether staff should also be personal customers.)
- **How accounts are created**:
  - `staff`: self sign-up on HOP Client (`/signup`) with name, email, password, job title,
    facility and unit.
  - `rep`, `facility_admin` and extra `console` users: created by a console user on the
    Console's Team screen. They are created with `status = 'invited'` and no password, and
    Resend emails them a one-time set-password link to *their* app's `/set-password?token=…`.
  - `customer`: self sign-up on the Concierge Portal (`/signup`) with name, email, phone and
    password. **No facility, no unit, no staff profile**: `createAuthRoutes({ allowCustomerSignup })`
    inserts `facility_id = NULL`, and `onCustomerSignup` writes `portal_customer_profiles`.
    Customers are not team members: the Console's Team screen never lists them.
  - The first `console` user: `node scripts/create-console-admin.mjs` (from the repo root,
    reads `DATABASE_URL`).
- **Sessions**: a random 32-byte token in an httpOnly, `SameSite=Lax`, `Secure` (on https)
  cookie named after the app's role: `hop_portal_staff`, `hop_portal_console`, `hop_portal_rep`,
  `hop_portal_facility_admin` or `hop_portal_customer`. (On localhost every app shares one cookie jar, because cookies
  ignore the port, so a single name would let signing in to one app sign you out of another.) Only `HMAC-SHA256(token, SESSION_HASH_SECRET)` is stored, in
  `portal_sessions`. The TTL is 30 days.
- **Email sign-in codes (v2.2, 2026-11)**: a correct password never starts a session by itself.
  `?action=login` answers `{ needsCode, challenge, sentTo }` and Resend emails a 6-digit code;
  `?action=verify-code { challenge, code }` starts the session. Sign-up (HOP Client staff and
  Concierge customers) works the same way, so an account is only usable once its email is
  proven. `?action=resend-code` sends a fresh code for the same challenge.
  - The challenge is 32 random bytes held by the browser; the code is bound to it. Only
    `HMAC(challenge)` and `HMAC(challenge + code)` are stored, in `portal_login_codes`.
  - A code lasts 10 minutes, is single use, and dies after 5 wrong guesses. Resend: 30 s apart,
    5 sends per challenge. At most 6 new challenges per user per 15 minutes. Asking for a new
    code retires the previous one.
  - A first successful code sets `portal_users.email_verified_at`. Invite and reset links
    (`/set-password`) sign in directly, because the emailed link already proves the inbox.
  - No bypass: if Resend can't send, sign-in fails with a 503, and `@demo.hop` accounts can't sign in.
  - UI: `@hop/shared/ui/CodeStep`, used by `LoginScreen` and both `SignupForm`s.
  - Lockout: 8 failed attempts lock the account for 15 minutes.
  - Passwords: bcrypt cost 12, minimum length 10.
  - Each app has its own domain, so each app has its own cookie. One person can't be signed into
    two apps with one cookie, and that's intended.
- **Every route handler** is wrapped as `export const GET = withAuth(APP_ROLE, async (request,
  user, ctx) => …)`. `withAuth` returns 401 when there's no session for this app's role, and
  turns any thrown `Response` (`throw json({ error }, 400)`) into the reply. Ownership is checked in the query:
  - A rep only reads and patches jobs where `rep_id = user.id`.
  - A staff member or customer only sees requests where `member_id = user.id`.
  - A facility admin only sees aggregates for `user.facility_id`, built only from `staff`
    accounts and `organization`-channel requests (see "Data separation" below).

## Data model (`db/schema.sql`, all tables prefixed `portal_`)

```
portal_facilities      id uuid, name, city, created_at
portal_units           id uuid, facility_id → facilities, name, created_at
portal_users           id uuid, email (unique, lower-cased), password_hash (null while invited),
                       role, first_name, last_name, phone, status ('invited'|'active'|'disabled'),
                       facility_id (staff + facility_admin), failed_login_attempts, locked_until,
                       created_at, last_login_at
portal_sessions        token_hash pk, user_id, expires_at, created_at
portal_password_tokens token_hash pk, user_id, purpose ('invite'|'reset'), expires_at, used_at
portal_staff_profiles  user_id pk, job_title, unit_id, prefs jsonb (what "HOP knows you"),
                       consents jsonb (watch/calendar/schedule consent intent), points int, lifetime_points int, updated_at
portal_point_claims    (user_id, earn_key, period) pk, points, claimed_at   (one claim per earn per day/week)
portal_requests        id text pk ('r'+8), member_id → users (NULL for instant requests),
                       status ('new'|'dispatched'|'completed'|'cancelled'), job_id, data jsonb (StaffRequest),
                       channel ('organization'|'concierge'|'instant', set from data.source), created_at, updated_at
portal_customer_profiles user_id pk, address jsonb, hear_about_us, created_at, updated_at   (Concierge Portal)
portal_jobs            id text pk ('d'+8), rep_id → users, request_id, status, data jsonb (Job),
                       created_at, updated_at
portal_job_events      id bigserial, job_id, actor_id, kind, detail jsonb, at   (audit timeline)
portal_door_events     id bigserial, job_id, actor_id, action ('unlock'|'lock'), at
portal_unit_signals    unit_id, day date, metric ('strain'|'stress'|'missed_breaks'|'requests'),
                       hour smallint null, value numeric, group_size int   (Facility View source)
portal_support_actions id uuid, facility_id, unit_id, actions jsonb, sent_by, status ('sent'|'resolved'), request_id, created_at
```

Jobs and requests keep their full detail in JSONB `data`, exactly the starter's `Job` /
`StaffRequest` shape, so the ported UI works unchanged. The indexed columns (`rep_id`,
`member_id`, `status`) are kept in sync on every write. `Job.rep` holds the rep's **user id**
(uuid), not a name like `"andre"`. Normalizing proofs and events out of `data` is a later step
(IT handoff §1).

## The cross-app flow

```
HOP Client ── POST /api/requests ─────────────▶ portal_requests (status new)
Console    ── GET  /api/requests (all) ◀────────┘
Console    ── POST /api/jobs {rep: <uuid>, requestId} ▶ portal_jobs (status offer); request → dispatched
Rep App    ── GET  /api/jobs (server filters rep_id = me) every 4 s
Rep App    ── PATCH /api/jobs/:id (status, updates, photos, sig, attn) ▶ portal_jobs + job_events
Console    ── GET  /api/jobs every 4 s ◀── sees Accepted → Started → In progress → Completed, proof, signature
HOP Client ── GET  /api/requests (mine) ◀── request status derived from its job's status
HOP Client ── POST /api/me?action=checkin|pulse ▶ portal_checkins (one per ET day / week)
Facility   ── GET  /api/facility (aggregates portal_checkins + portal_requests for my facility; < 5 people hidden)
Facility   ── POST /api/facility?action=support ▶ portal_support_actions (+ a Console queue item, unit-level, no names)
```

v2 flows (2026-10-19):

```
Any app    ── GET/POST /api/messages (createMessageRoutes) ▶ portal_messages; canUseThread() decides access
Rep App    ── POST /api/door {ask}           ▶ door.state asked (setDoorState)
HOP Client ── POST /api/me?action=door        ▶ asked → ok | denied (only the member whose request it is)
Rep App    ── POST /api/door {unlock|lock}    ▶ ok/closed → open → closed + portal_door_events
Rep App    ── PATCH status declined           ▶ the request goes back to new (Console: "Rep passed")
Rep App    ── POST /api/me?action=safety      ▶ urgent rep/<id> message + request source 'safety'
HOP Client ── POST /api/me?action=redeem      ▶ points deducted + portal_redemptions + request source 'reward'
HOP Client ── POST /api/me?action=rate        ▶ portal_ratings (Console service rating, rep rating)
HOP Client ── POST /api/play?game=…           ▶ answers scored on the server, portal_game_plays + points
```

v2.1 flows (2026-11):

```
Concierge Portal ── POST /api/requests (conciergeRequestSchema) ▶ portal_requests (source 'concierge', channel 'concierge')
Public site      ── POST /api/request (no account)              ▶ portal_requests (source 'instant', channel 'instant',
                                                                  member_id NULL, contact in data.details) + owner email
Console          ── GET  /api/requests ◀── both show in the queue as "Concierge Portal" / "Instant request",
                                           with the details panel (address, flight, payment preference)
Console          ── dispatch ▶ job notes carry the details, never payment
Concierge Portal ── GET  /api/requests (mine), cancel while 'new', messages on its own member thread
```

Request details (`ConciergeDetails`, `packages/shared/src/types.ts`): request type, date and time
needed, address, flight (only for the flight request types), payment preference (method,
cardholder name, last 4 digits; **never** a full card number, expiry or CVV; the team takes
payment by phone, `TODO(IT)` hosted checkout) and how they heard about HOP. The public site keeps a
mirrored copy of the option lists in `apps/site/src/site/conciergeRequest.ts` because it can't
import `@hop/shared`.

Each app hosts its **own** route handlers for the resources it touches, and all of them call the
same `@hop/shared/server/store` functions against the same database. There is no shared API
server and no cross-origin calls between apps.

### Who may change what on a job

| Field | Console | Rep (own jobs only) |
|---|---|---|
| `rep` (reassign) | ✓ | ✗ |
| `status` | ✓ | ✓ forward only: offer→accepted/declined→started→in_progress→completed |
| `log`, `updates`, `notesList`, `done`, `attn`, `share` | ✓ | ✓ |
| `photos`, `sig`, `signedBy` | view | ✓ |
| `door` | view | ✗ in a PATCH. Only through `setDoorState()`: the rep asks, opens and closes via `/api/door`; the member approves in HOP Client |

The server enforces this with two zod schemas, `consolePatchJobSchema` and
`repPatchJobSchema`. Don't use a single permissive schema.

## Realtime, uploads, integrations

- **Realtime**: client polling every 4 s (`useJobs`), as in the starter. Local edits are applied
  optimistically. Swapping to SSE/Pusher/Ably is a later step (`TODO(IT)` in `client.ts`).
- **Photo and signature proof (private, v2.3)**: `POST /api/uploads` (Rep App, the job must be the
  rep's and still taking proof) stores the image in `portal_proof_files` (bytea, 2 MB cap) and
  returns a reference, `proof:<uuid>`. Jobs only ever hold these references (`img` in
  `validate.ts` rejects URLs and data URLs), and a rep's PATCH is refused unless every reference
  was uploaded for that same job (`proofsBelongToJob`). There is no public URL: each app serves
  `GET /api/proofs/<uuid>` through `createProofRoute` (`@hop/shared/server/proofs`) only to a
  signed-in user allowed to see the job, otherwise 401/404:
  - Rep App: jobs dispatched to that rep.
  - Console: every job.
  - HOP Client: the member's own request, once completed.

  Screens turn a reference into that path with `proofSrc()` (`@hop/shared/proof`). Responses are
  `Cache-Control: private`. Vercel Blob is no longer used.
- **Masked calls (Twilio), smart locks (Seam), push (OneSignal)**: stubs in
  `@hop/shared/server/integrations` that log and return demo values. The Rep App's Call/Text
  buttons use `tel:`/`sms:` links until Twilio is wired.

## Deployments

| Vercel project | Root Directory | Framework | Env vars |
|---|---|---|---|
| `hop_services` (www.hopserves.com) | `apps/site` | Vite | `DATABASE_URL`, `RESEND_API_KEY`, `NOTIFY_EMAIL`, `VITE_CLIENT_URL`, `VITE_CONSOLE_URL`, `VITE_REP_URL`, `VITE_FACILITY_URL`, `VITE_CONCIERGE_URL` (baked in at build: redeploy after changing) |
| `hop-client` (hop-client.hopserves.com) | `apps/staff` | Next.js | shared set ↓ + `APP_URL` |
| `hop-console` (hop-console.hopserves.com) | `apps/console` | Next.js | shared set + `APP_URL`, `STAFF_URL`, `REP_URL`, `FACILITY_URL` (for invite links) |
| `hop-rep` (concierge-rep-app.hopserves.com) | `apps/rep` | Next.js | shared set + `APP_URL` |
| `hop-facility` (hop-facility.hopserves.com) | `apps/facility` | Next.js | shared set + `APP_URL` |
| `concierge_account` (concierge.hopserves.com) | `apps/concierge` | Next.js | shared set + `APP_URL` |

The shared set is `DATABASE_URL`, `SESSION_HASH_SECRET` and `RESEND_API_KEY`, the same values in
every project.

- All six projects deploy from `main`. Every Portal app also gets `CONCIERGE_URL` (wrong-app
  message), and the site gets `VITE_CONCIERGE_URL`. Vercel detects npm workspaces and installs from the repo
  root.
- In each Portal project, "Include files outside the root directory" must stay on (the default),
  because the apps import `packages/shared`.
- No "Ignored Build Step": every push to `main` rebuilds all six. (A git-diff skip was tried and
  silently skipped real changes on multi-commit pushes, so it was removed on 2026-10-19.)
- The old `theconcierge-staff` project and the `staff-portal` branch are retired in Phase 6.

## Privacy rules (from the IT handoff, non-negotiable)

- Facility View shows **unit totals only**, and any unit or cell with fewer than `MIN_GROUP_SIZE`
  (5) people is suppressed **server-side**, not just hidden in the UI. No names, ever.
- No watch, calendar or schedule data is collected until a privacy/HIPAA review is done. Those
  screens show sample data and "Connect" flows that only record consent intent.
- Proof photos and signatures are private: stored in the database and served only to signed-in users allowed to see the job (done 2026-11).
- **Data separation (2026-11).** Individual customer activity never reaches organization
  reporting. Concierge customers have no facility and no staff profile; instant requests have no
  account. On top of that, every Facility View query requires the requester's role to be `staff`
  and the request's `channel` to be `organization`, and check-ins require a `staff` account.
  `npm run hop:check-separation` is a read-only leak test against the database.
