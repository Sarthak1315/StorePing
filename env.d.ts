/// <reference types="@remix-run/node" />
/// <reference types="vite/client" />

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
