import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import {
  AppProvider as PolarisAppProvider,
  Page,
  Card,
  Banner,
  BlockStack,
  Text,
  Button,
} from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
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
        <Link to="/app/orders">Orders & 1-Click Send</Link>
        <Link to="/app/inbox">Live Inbox & Search</Link>
        <Link to="/app/automations">Automations (7 Flows)</Link>
        <Link to="/app/templates">Templates & Simulator</Link>
        <Link to="/app/connect">Connect WhatsApp</Link>
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
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page title="StorePing Status">
        <BlockStack gap="400">
          <Banner tone="critical" title="Application Notice">
            <p>
              StorePing encountered an issue. Details are shown below:
            </p>
          </Banner>

          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Diagnostic Details</Text>
              <Text as="p" tone="subdued">{errorMessage}</Text>
              {errorDetails && (
                <pre style={{ background: "#0f172a", color: "#f8fafc", padding: "16px", borderRadius: "8px", fontSize: "12px", overflowX: "auto" }}>
                  {errorDetails}
                </pre>
              )}
              <Button onClick={() => window.location.reload()}>Retry Connection</Button>
            </BlockStack>
          </Card>
        </BlockStack>
      </Page>
    </PolarisAppProvider>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
