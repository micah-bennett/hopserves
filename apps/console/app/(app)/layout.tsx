import { requirePageUser } from "@hop/shared/server/session";
import { IdleGuard } from "@hop/shared/ui/IdleGuard";
import ConsoleHeader from "@/components/ConsoleHeader";
import { APP_NAME, APP_ROLE } from "@/lib/app";

export const dynamic = "force-dynamic";

/** Everything inside (app)/ requires a signed-in console user, signed out after 30 idle minutes. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser(APP_ROLE);
  return (
    <>
      <IdleGuard />
      <ConsoleHeader name={APP_NAME} user={`${user.firstName} ${user.lastName}`} />
      {children}
    </>
  );
}
