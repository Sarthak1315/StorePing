import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider,
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
  Banner,
  BlockStack,
} from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { login } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const result = await login(request);
  return { errors: (result as any)?.errors || {}, polarisTranslations };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const result = await login(request);
  return { errors: (result as any)?.errors || {} };
};

export default function AuthLogin() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const errors = actionData?.errors || loaderData?.errors || {};

  return (
    <PolarisAppProvider i18n={loaderData.polarisTranslations}>
      <Page narrowWidth>
        <BlockStack gap="400">
          <Card>
            <Form method="post">
              <FormLayout>
                <Text variant="headingLg" as="h1">
                  Log in to StorePing
                </Text>
                <Text as="p" tone="subdued">
                  Enter your Shopify store domain to connect WhatsApp Automations.
                </Text>

                {errors?.shop && (
                  <Banner tone="critical">
                    <p>{errors.shop}</p>
                  </Banner>
                )}

                <TextField
                  type="text"
                  name="shop"
                  label="Shop domain"
                  helpText="e.g. your-store-name.myshopify.com"
                  value={shop}
                  onChange={setShop}
                  autoComplete="on"
                  error={errors.shop}
                  placeholder="my-shop.myshopify.com"
                />

                <Button variant="primary" submit>
                  Install / Log in
                </Button>
              </FormLayout>
            </Form>
          </Card>
        </BlockStack>
      </Page>
    </PolarisAppProvider>
  );
}
