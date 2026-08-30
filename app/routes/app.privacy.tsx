import { useState, useEffect } from "react";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  Badge,
  BlockStack,
  InlineStack,
  Divider,
  Banner,
  Modal,
  List,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  getConsent,
  saveConsent,
  withdrawConsent,
  exportUserData,
  eraseUserData,
  ITEMISED_PURPOSES,
} from "../utils/dpdp.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const consent = await getConsent(shop);

  return json({
    shop,
    consent,
    itemisedPurposes: ITEMISED_PURPOSES,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const body = await request.formData();
  const intent = body.get("intent");

  if (intent === "grantConsent") {
    await saveConsent(shop, {
      consented: true,
      purposes: ITEMISED_PURPOSES.map((p) => p.key),
      userAgent: request.headers.get("user-agent"),
    });
    return json({ success: true, message: "Consent granted successfully" });
  }

  if (intent === "withdrawConsent") {
    await withdrawConsent(shop);
    return json({ success: true, message: "Consent withdrawn successfully" });
  }

  if (intent === "exportData") {
    const exportPayload = await exportUserData(shop);
    return json({ success: true, exportPayload });
  }

  if (intent === "eraseData") {
    await eraseUserData(shop);
    return json({
      success: true,
      erased: true,
      message: "All store data, logs, and WhatsApp credentials have been permanently erased.",
    });
  }

  return json({ success: true });
};

export default function PrivacyPage() {
  const { shop, consent, itemisedPurposes } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [showEraseModal, setShowEraseModal] = useState(false);
  const isConsented = consent?.consented ?? true;
  const exportData = (fetcher.data as any)?.exportPayload;

  const handleDownloadJSON = () => {
    if (!exportData) return;
    const jsonString = `data:text/json;charset=utf-8,${encodeURIComponent(
      JSON.stringify(exportData, null, 2)
    )}`;
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", jsonString);
    downloadAnchor.setAttribute("download", `storeping_dpdp_export_${shop.replace(/[^a-zA-Z0-9]/g, "_")}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Floating Toast Notification Handler (No top banners)
  useEffect(() => {
    if (fetcher.data && "message" in fetcher.data) {
      try {
        if (typeof window !== "undefined" && (window as any).shopify?.toast) {
          (window as any).shopify.toast.show((fetcher.data as any).message, { duration: 4000 });
        }
      } catch {}
    }
  }, [fetcher.data]);

  return (
    <Page
      fullWidth
      title="Privacy"
      subtitle="DPDP Act 2023 & GDPR data governance and compliance center."
    >
      <Layout>

        {/* Consent Status Card */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Data Processing Consent</Text>
                <Badge tone={isConsented ? "success" : "critical"}>
                  {isConsented ? "Consent Granted" : "Consent Withdrawn"}
                </Badge>
              </InlineStack>

              <Divider />

              <Text as="p">
                StorePing complies with the Indian Digital Personal Data Protection Act (DPDP Act 2023) and GDPR.
                Personal customer data (such as phone numbers for order dispatch) is processed strictly under lawful, itemized purposes.
              </Text>

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Itemized Processing Purposes:</Text>
                <List type="bullet">
                  {itemisedPurposes.map((p) => (
                    <List.Item key={p.key}>
                      <strong>{p.title}:</strong> {p.description}
                    </List.Item>
                  ))}
                </List>
              </BlockStack>

              <Divider />

              <InlineStack gap="300">
                {isConsented ? (
                  <Button
                    variant="plain"
                    tone="critical"
                    onClick={() => {
                      const form = new FormData();
                      form.append("intent", "withdrawConsent");
                      fetcher.submit(form, { method: "POST" });
                    }}
                  >
                    Withdraw Consent
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => {
                      const form = new FormData();
                      form.append("intent", "grantConsent");
                      fetcher.submit(form, { method: "POST" });
                    }}
                  >
                    Grant Consent
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Data Principal Rights (Export & Erasure) */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Data Principal Rights (Access & Erasure)</Text>
              <Divider />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">📥 Right to Data Portability (JSON Export)</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Export a full JSON record of your store configuration, message audit trail, and customer logs.
                  </Text>
                  <Button
                    onClick={() => {
                      const form = new FormData();
                      form.append("intent", "exportData");
                      fetcher.submit(form, { method: "POST" });
                    }}
                    loading={fetcher.state !== "idle" && !exportData}
                  >
                    Export Store Data (JSON)
                  </Button>
                  {exportData && (
                    <Button variant="primary" onClick={handleDownloadJSON}>
                      ⬇️ Download Generated JSON
                    </Button>
                  )}
                </BlockStack>

                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">🗑️ Right to Erasure (Permanent Wipe)</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Permanently delete all WhatsApp credentials, message logs, cart recovery records, and store settings from StorePing.
                  </Text>
                  <Button variant="plain" tone="critical" onClick={() => setShowEraseModal(true)}>
                    Erase All Store Data
                  </Button>
                </BlockStack>
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {/* Confirmation Modal for Permanent Erasure */}
      <Modal
        open={showEraseModal}
        onClose={() => setShowEraseModal(false)}
        title="Confirm Permanent Data Erasure"
        primaryAction={{
          content: "Permanently Erase All Data",
          destructive: true,
          onAction: () => {
            setShowEraseModal(false);
            const form = new FormData();
            form.append("intent", "eraseData");
            fetcher.submit(form, { method: "POST" });
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setShowEraseModal(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              Are you sure you want to permanently erase all data for <strong>{shop}</strong>?
            </Text>
            <Text as="p" tone="critical">
              This action cannot be undone. All WhatsApp tokens, custom message templates, message history, and recovery logs will be purged immediately.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
