import { requirePageUser } from "@hop/shared/server/session";
import { IdleGuard } from "@hop/shared/ui/IdleGuard";
import { APP_ROLE } from "@/lib/app";

export const dynamic = "force-dynamic";

/** Everything inside (app)/ requires a signed-in user with this app's role, signed out after 30 idle minutes. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requirePageUser(APP_ROLE);
  return (
    <>
      <IdleGuard />
      {children}
    </>
  );
}
