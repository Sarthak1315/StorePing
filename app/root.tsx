import type { LinksFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "@remix-run/react";
import tailwindStyles from "./tailwind.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: tailwindStyles },
];

export async function loader({ request: _ }: LoaderFunctionArgs) {
  return json({
    ENV: {
      META_APP_ID: process.env.META_APP_ID ?? "",
      META_CONFIG_ID: process.env.META_CONFIG_ID ?? "",
    },
  });
}

export default function App() {
  const { ENV } = useLoaderData<typeof loader>();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/* Performance Preconnections */}
        <link rel="preconnect" href="https://cdn.shopify.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cdn.shopify.com" />
        <link rel="preconnect" href="https://graph.facebook.com" />
        <link rel="dns-prefetch" href="https://graph.facebook.com" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body {
                background-color: #f1f2f4 !important;
                margin: 0;
                padding: 0;
                min-height: 100vh;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
                -webkit-font-smoothing: antialiased;
              }
              #loading-bar {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                height: 3px;
                background: linear-gradient(90deg, #10b981, #06b6d4, #10b981);
                background-size: 200% 100%;
                animation: loading-pulse 1.2s infinite ease-in-out;
                z-index: 999999;
              }
              @keyframes loading-pulse {
                0% { background-position: 100% 0; }
                100% { background-position: -100% 0; }
              }

              /* 0ms Instant Splash Loader before JS hydrates */
              #initial-splash-loader {
                position: fixed;
                inset: 0;
                background-color: #f1f2f4;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 99999;
                transition: opacity 0.25s ease-out;
              }
              .splash-card {
                background: #ffffff;
                border: 1px solid #e1e3e5;
                border-radius: 12px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
                padding: 28px 40px;
                display: flex;
                flex-direction: column;
                align-items: center;
                min-width: 250px;
                text-align: center;
              }
              .splash-icon {
                width: 48px;
                height: 48px;
                border-radius: 10px;
                background: #008060;
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 14px;
                box-shadow: 0 2px 8px rgba(0, 128, 96, 0.25);
              }
              .splash-title {
                font-weight: 600;
                font-size: 15px;
                color: #202223;
                margin-bottom: 4px;
              }
              .splash-sub {
                font-size: 13px;
                color: #6d7175;
                margin-bottom: 16px;
              }
              .splash-bar {
                width: 140px;
                height: 4px;
                background: #e4e5e7;
                border-radius: 999px;
                overflow: hidden;
                position: relative;
              }
              .splash-fill {
                position: absolute;
                top: 0;
                bottom: 0;
                left: 0;
                width: 45%;
                background: #008060;
                border-radius: 999px;
                animation: splash-anim 1.2s infinite ease-in-out;
              }
              @keyframes splash-anim {
                0% { left: -45%; width: 45%; }
                50% { left: 25%; width: 60%; }
                100% { left: 100%; width: 45%; }
              }
            `,
          }}
        />
        <Meta />
        <Links />
      </head>
      <body>
        {/* Instant visual feedback in 0ms */}
        <div id="initial-splash-loader">
          <div className="splash-card">
            <div className="splash-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
              </svg>
            </div>
            <div className="splash-title">StorePing WhatsApp</div>
            <div className="splash-sub">Loading workspace...</div>
            <div className="splash-bar">
              <div className="splash-fill"></div>
            </div>
          </div>
        </div>

        <script
          dangerouslySetInnerHTML={{
            __html: `window.__ENV__ = ${JSON.stringify(ENV)}`,
          }}
        />
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
