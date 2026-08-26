/// <reference types="@remix-run/node" />
/// <reference types="vite/client" />

declare module "@shopify/shopify-app-remix/server" {
  export const boundary: {
    error: (error: any) => JSX.Element;
    headers: (headersArgs: any) => Headers;
  };
  export const ApiVersion: any;
  export const AppDistribution: any;
  export const DeliveryMethod: any;
  export function shopifyApp(config: any): any;
  export function unauthenticated(config: any): any;
  export function login(request: Request): Promise<any>;
}

declare module "@shopify/shopify-app-remix/react" {
  import type { ReactNode } from "react";
  export interface AppProviderProps {
    isEmbeddedApp?: boolean;
    apiKey: string;
    children: ReactNode;
    [key: string]: any;
  }
  export function AppProvider(props: AppProviderProps): JSX.Element;
  export function useAppBridge(): any;
}

declare module "@shopify/shopify-app-remix/adapters/node" {
  export * from "@shopify/shopify-app-remix/server";
}
