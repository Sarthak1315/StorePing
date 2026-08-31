import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { destroyPortalSession } from "../utils/portal-auth.server";

export async function action({ request }: ActionFunctionArgs) {
  return destroyPortalSession(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return destroyPortalSession(request);
}
