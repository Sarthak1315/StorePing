import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useNavigation, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useEffect } from "react";
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
  Spinner,
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
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading" || navigation.state === "submitting";

  // Remove the 0ms initial splash loader once React takes over
  useEffect(() => {
    if (typeof document !== "undefined") {
      const splash = document.getElementById("initial-splash-loader");
      if (splash) {
        splash.style.opacity = "0";
        setTimeout(() => {
          splash.remove();
        }, 260);
      }
    }
  }, []);

  // Sync with Shopify App Bridge top-bar native loading indicator
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && (window as any).shopify?.loading) {
        if (isLoading) {
          (window as any).shopify.loading(true);
        } else {
          (window as any).shopify.loading(false);
        }
      }
    } catch {
      // Ignore if App Bridge loading is unavailable
    }
  }, [isLoading]);

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      {/* Top progress bar for route transitions */}
      {isLoading && <div id="loading-bar" />}

      {/* Floating Transition Indicator */}
      {isLoading && (
        <div
          style={{
            position: "fixed",
            top: "16px",
            right: "24px",
            zIndex: 99999,
            backgroundColor: "rgba(32, 34, 35, 0.92)",
            color: "#ffffff",
            padding: "8px 16px",
            borderRadius: "20px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "13px",
            fontWeight: 500,
            backdropFilter: "blur(4px)",
          }}
        >
          <Spinner size="small" />
          <span>Updating...</span>
        </div>
      )}

      <NavMenu>
        <Link to="/app" rel="home">Dashboard</Link>
        <Link to="/app/orders">Orders</Link>
        <Link to="/app/inbox">Live Inbox & Search</Link>
        <Link to="/app/automations">Automations (7 Flows)</Link>
        <Link to="/app/templates">Templates & Simulator</Link>
        <Link to="/app/connect">Connect WhatsApp</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/privacy">DPDP Privacy</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>

      <div
        style={{
          opacity: isLoading ? 0.7 : 1,
          transition: "opacity 0.15s ease-in-out",
          minHeight: "100vh",
          width: "100%",
        }}
      >
        <Outlet />
      </div>
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
            <p>StorePing encountered an issue. Details are shown below:</p>
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
