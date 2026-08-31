import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { requirePortalUser } from "../utils/portal-auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requirePortalUser(request);
  if (user.role === "AGENT") {
    return redirect("/portal/inbox");
  }
  return redirect("/portal/dashboard");
}

export default function PortalIndex() {
  return null;
}
