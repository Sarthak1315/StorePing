import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { Page, Card, Banner, BlockStack, Text, Button } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Dashboard</Link>
        <Link to="/app/connect">Connect WhatsApp</Link>
        <Link to="/app/automations">Automations</Link>
        <Link to="/app/templates">Templates & Simulator</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/privacy">DPDP Privacy</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  let errorMessage = "An unexpected error occurred while loading StorePing.";
  let errorDetails = "";

  if (isRouteErrorResponse(error)) {
    errorMessage = `${error.status} ${error.statusText}`;
    errorDetails = error.data?.message || "";
  } else if (error instanceof Error) {
    errorMessage = error.message;
    errorDetails = error.stack || "";
  }

  return (
    <Page title="StorePing Status">
      <BlockStack gap="400">
        <Banner tone="critical" title="Application Error">
          <p>
            StorePing encountered an issue connecting to services. If this is a database connection issue, please ensure your database is active and reachable.
          </p>
        </Banner>

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd" as="h2">Diagnostic Details</Text>
            <Text as="p" tone="subdued">{errorMessage}</Text>
            {errorDetails && (
              <pre className="bg-slate-900 text-slate-200 p-4 rounded-lg text-xs overflow-x-auto">
                {errorDetails}
              </pre>
            )}
            <Button onClick={() => window.location.reload()}>Retry Connection</Button>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
